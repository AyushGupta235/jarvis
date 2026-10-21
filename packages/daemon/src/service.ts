import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  ActivityEntry, AgentDef, AttachSpec, ChangedFile, Connector, CreateSessionParams, DaemonInfo, DocEntry, FileContent,
  FileEntry, RepoCandidate, RichConversation, RichEnvelope, RichInfo, RichPermissionMode, SessionInfo, SessionMode, Snapshot,
  UsageSummary, WorkspaceInfo,
} from '@jarvis/protocol';
import { execFile } from 'node:child_process';
import { fill, type AgentRegistry } from './agents';
import type { Observers } from './observers';
import type { CodexObserver } from './codex';
import type { UsageIndexer } from './usage';
import type { PrTracker, RemoteCache } from './prs';
import type { RichSessions } from './rich';
import { findTranscript, readThinking } from './thinking';
import { FileWatcher, changes as fileChanges, diff as fileDiff, listFiles, readFile } from './files';
import { listDocs } from './docs';
import { checkConnectors, listConnectors } from './connectors';
import { findBinary } from './env';
import type { Db, SessionRow } from './db';
import { Tmux, type LiveSession } from './tmux';
import { BranchCache, listWorktrees, locate, scanRepos } from './git';
import { userShell } from './env';
import { log, logError } from './log';

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function shortId(): string {
  return randomBytes(4).toString('base64url').replace(/[-_]/g, 'x').slice(0, 6).toLowerCase();
}

/** Claude stores transcripts at ~/.claude/projects/<encoded cwd>/<uuid>.jsonl. */
export function claudeTranscriptExists(uuid: string, claudeHome = join(homedir(), '.claude')): boolean {
  const root = join(claudeHome, 'projects');
  try {
    for (const d of readdirSync(root)) if (existsSync(join(root, d, `${uuid}.jsonl`))) return true;
  } catch { /* no projects dir */ }
  return false;
}

/** The agent's command line, or null for a plain shell. Agents run unmodified; this only builds argv. */
export function buildAgentCommand(
  def: AgentDef,
  row: Pick<SessionRow, 'model' | 'agent_session_id' | 'name'>,
  opts: { resume: boolean; extraArgs?: string[]; claudeSettings?: string | null },
): string | null {
  if (!def.command) return null;
  const vars = { model: row.model, sessionId: row.agent_session_id, name: row.name };
  const parts = [def.command, ...(def.args ?? [])];
  // Observer hooks + status line tap, layered on top of the user's own settings (never replacing them).
  if (def.integration === 'claude' && opts.claudeSettings) parts.push('--settings', opts.claudeSettings);
  if (opts.resume && def.resumeArgs) parts.push(...fill(def.resumeArgs, vars));
  else {
    parts.push(...fill(def.sessionIdArgs, vars));
    parts.push(...fill(def.nameArgs, vars));
  }
  parts.push(...fill(def.modelArgs, vars));
  parts.push(...(opts.extraArgs ?? []));
  return parts.map(shellQuote).join(' ');
}

/** What to show when polling tmux fails. Running out of file handles is a machine-wide problem, so say so. */
export function pollHealthMessage(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/ENFILE/.test(msg)) {
    return 'macOS is out of open files (ENFILE), so Jarvis cannot see tmux and session state may be stale. Some other app is holding too many files; quit it, or check `sysctl kern.num_files kern.maxfiles`.';
  }
  if (/EMFILE/.test(msg)) return 'jarvisd hit its open-file limit (EMFILE), so session state may be stale. `jarvis daemon restart` clears it.';
  return `Jarvis cannot reach tmux, so session state may be stale: ${(msg.split('\n')[0] ?? '').slice(0, 200)}`;
}

export interface ServiceOptions {
  db: Db;
  tmux: Tmux;
  /** tmux on the default socket, for listing sessions Jarvis did not start. */
  externalTmux: Tmux | null;
  info: DaemonInfo;
  repoRoots: string[];
  agents: AgentRegistry;
  observers: Observers;
  codex: CodexObserver;
  usage: UsageIndexer;
  prs: PrTracker;
  remotes: RemoteCache;
  files: FileWatcher;
  rich: RichSessions;
  claudeSettings: string | null;
  socketPath: string;
  env: NodeJS.ProcessEnv;
}

export class JarvisService extends EventEmitter {
  private live = new Map<string, LiveSession>(); // by tmux name
  private external: LiveSession[] = [];
  private branches = new BranchCache();
  private lastSnapshotJson = '';
  private timer: NodeJS.Timeout | null = null;
  private tick = 0;
  private polling = false;
  private health: string | null = null;

  private publishTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: ServiceOptions) {
    super();
    const soon = () => {
      if (this.publishTimer) return;
      this.publishTimer = setTimeout(() => {
        this.publishTimer = null;
        this.publish();
      }, 80);
    };
    o.observers.on('state', soon);
    o.observers.on('limits', () => {
      o.db.kvSet('limits.claude', o.observers.claudeLimits);
      soon();
    });
    const saved = o.db.kvGet('limits.claude') as Observers['claudeLimits'] | null;
    if (saved) o.observers.claudeLimits = saved;
    o.usage.projectResolver = (cwd) => this.resolveProject(cwd);
    o.usage.live = () => {
      const n = (o.db.raw.prepare(`select count(*) as n from events where kind = 'tool' and ts > ?`).get(Date.now() - 300_000) as { n: number }).n;
      const working = o.db.allSessions().filter((r) => o.observers.state(r.id)?.phase === 'working').length;
      return { liveToolCallsPerMin: Math.round((n / 5) * 10) / 10, workingNow: working };
    };
    o.prs.on('changed', soon);
    o.usage.onLimits = soon;
    o.observers.on('activity', (e: ActivityEntry) => this.emit('activity', e));
    o.observers.on('attention', (a) => this.emit('attention', a));
    o.observers.on('agentSessionId', ({ id, agentSessionId }: { id: string; agentSessionId: string }) => {
      const r = this.o.db.getSession(id);
      if (r && r.agent_session_id !== agentSessionId) this.o.db.updateSession(id, { agent_session_id: agentSessionId });
    });
    o.files.on('changed', (c) => this.emit('files.changed', c));
    o.rich.on('changed', () => void this.poll());
    o.rich.on('event', (id: string, envelope: RichEnvelope) => {
      this.emit('rich.event', { sessionId: id, envelope });
      // Hooks report most state for rich sessions too; permission requests only exist on the SDK side.
      const ev = envelope.event;
      if (ev.kind === 'status' && ev.agentSessionId) {
        // /clear starts a new conversation; revive and the terminal switch must reopen the live one.
        const r = o.db.getSession(id);
        if (r && r.agent_session_id !== ev.agentSessionId) o.db.updateSession(id, { agent_session_id: ev.agentSessionId });
      }
      if (ev.kind === 'permission_request') o.observers.setPhase(id, 'needs_input', `Permission: ${ev.tool}`);
      else if (ev.kind === 'permission_resolved' && o.observers.state(id)?.phase === 'needs_input') o.observers.setPhase(id, 'working');
      else if (ev.kind === 'turn_end' && o.observers.state(id)?.phase !== 'done') o.observers.setPhase(id, 'done', ev.ok ? null : ev.error);
    });
    for (const r of o.db.allSessions()) {
      o.observers.setCwd(r.id, r.cwd);
      if (this.o.agents.list().find((a) => a.id === r.agent)?.integration === 'codex' && r.status === 'running') {
        o.codex.track(r.id, r.cwd, r.created_at);
      }
    }
  }

  start(): void {
    const richIds = this.o.db.allSessions().filter((r) => r.mode === 'rich').map((r) => r.id);
    void this.o.rich.restore(richIds).finally(() => void this.poll());
    this.timer = setInterval(() => void this.poll(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  info(): DaemonInfo {
    return this.o.info;
  }

  /** Poll tmux, reconcile with the registry, emit a snapshot when anything visible changed. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const sessions = await this.o.tmux.listSessions();
      this.live = new Map(sessions.map((s) => [s.name, s]));
      if (this.o.externalTmux && this.tick % 3 === 0) {
        this.external = await this.o.externalTmux.listSessions().catch(() => []);
      }
      this.tick++;
      this.health = null;
      await this.reconcile();
      this.publish();
    } catch (e) {
      logError('poll failed', e);
      this.health = pollHealthMessage(e);
      this.publish();
    } finally {
      this.polling = false;
    }
  }

  private async reconcile(): Promise<void> {
    const { db } = this.o;
    const rows = db.allSessions();
    const byTmux = new Map(rows.map((r) => [r.tmux_name, r]));
    const now = Date.now();
    for (const r of rows) {
      const alive = r.mode === 'rich' ? this.o.rich.connected(r.id) : this.live.has(r.tmux_name);
      if (r.status === 'running' && !alive) {
        db.updateSession(r.id, { status: 'exited', exited_at: now });
        log(`session ${r.id} (${r.name}) exited`);
      } else if (r.status === 'exited' && alive) {
        db.updateSession(r.id, { status: 'running', exited_at: null });
      }
    }
    // Adopt tmux sessions on the Jarvis socket that the registry does not know (db reset, manual `tmux -L jarvis new`).
    for (const s of this.live.values()) {
      if (byTmux.has(s.name)) continue;
      const id = s.jarvisId && !db.getSession(s.jarvisId) ? s.jarvisId : shortId();
      const loc = await locate(s.currentPath || homedir());
      db.insertSession({
        id, tmux_name: s.name, name: s.name, agent: 'shell', model: null, agent_session_id: null,
        cwd: s.currentPath || homedir(), repo_root: loc.repoRoot, worktree: loc.worktree, hidden: 0,
        status: 'running', created_at: s.created || now, exited_at: null, sort_order: db.nextOrder(), mode: 'terminal', permission_mode: null,
      });
      if (s.jarvisId !== id) await this.o.tmux.run(['set-option', '-t', Tmux.paneTarget(s.name), '@jarvis_id', id]).catch(() => {});
      log(`adopted tmux session ${s.name} as ${id}`);
    }
  }

  snapshot(): Snapshot {
    const rows = this.o.db.allSessions();
    const sessions: SessionInfo[] = rows.map((r) => this.toInfo(r));
    let order = rows.length;
    for (const e of this.external) {
      sessions.push({
        id: `ext:${e.name}`, tmuxName: e.name, name: e.name, agent: this.guessAgent(e.currentCommand), model: null,
        agentSessionId: null, cwd: e.currentPath, currentPath: e.currentPath, repoRoot: 'tmux:default',
        worktree: null, branch: this.branches.get(e.currentPath), hidden: false, status: 'running',
        createdAt: e.created, exitedAt: null, lastActivity: e.activity, attachedClients: e.attached,
        paneCommand: e.currentCommand, panePid: e.panePid, external: true, order: order++, agentState: null, pr: null,
        mode: 'terminal', rich: null,
      });
    }
    const wsMap = new Map<string, WorkspaceInfo>();
    for (const s of sessions) {
      if (!wsMap.has(s.repoRoot)) {
        wsMap.set(s.repoRoot, {
          root: s.repoRoot,
          name: s.repoRoot === 'tmux:default' ? 'tmux (default socket)' : basename(s.repoRoot) || s.repoRoot,
        });
      }
    }
    return {
      daemon: this.o.info, health: this.health, agents: this.o.agents.list(), prs: this.o.prs.state, limits: this.limits(), sessions,
      workspaces: [...wsMap.values()],
    };
  }

  private toInfo(r: SessionRow): SessionInfo {
    const isRich = r.mode === 'rich';
    const l = isRich ? undefined : this.live.get(r.tmux_name);
    const path = l?.currentPath || r.cwd;
    const running = isRich ? this.o.rich.connected(r.id) : !!l;
    return {
      mode: r.mode,
      rich: isRich ? { hostPid: this.o.rich.hostPid(r.id), connected: running } : null,
      id: r.id, tmuxName: r.tmux_name, name: r.name, agent: r.agent, model: r.model,
      agentSessionId: r.agent_session_id, cwd: r.cwd, currentPath: l?.currentPath ?? null,
      repoRoot: r.repo_root, worktree: r.worktree, branch: this.branches.get(path), hidden: !!r.hidden,
      status: running ? 'running' : 'exited', createdAt: r.created_at, exitedAt: r.exited_at,
      lastActivity: l?.activity ?? (isRich ? this.richLastActivity(r.id) : null), attachedClients: l?.attached ?? 0,
      paneCommand: l?.currentCommand ?? (isRich && running ? 'claude (rich)' : null),
      panePid: l?.panePid ?? null, external: false, order: r.sort_order,
      agentState: this.o.observers.state(r.id),
      pr: this.o.prs.forBranch(this.o.remotes.get(r.repo_root), this.branches.get(path)),
    };
  }

  private richLastActivity(id: string): number | null {
    return this.o.rich.history(id).at(-1)?.ts ?? null;
  }

  publish(force = false): void {
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    if (!force && json === this.lastSnapshotJson) return;
    this.lastSnapshotJson = json;
    this.emit('snapshot', snap);
  }

  private row(id: string): SessionRow {
    const r = this.o.db.getSession(id);
    if (!r) throw new Error(`unknown session ${id}`);
    return r;
  }

  async create(p: CreateSessionParams): Promise<SessionInfo> {
    const cwd = p.cwd.replace(/^~(?=$|\/)/, homedir());
    if (!existsSync(cwd)) throw new Error(`directory does not exist: ${cwd}`);
    const def = this.o.agents.get(p.agent);
    if (def.command && def.available === false) {
      throw new Error(`${def.label} is not installed (\`${def.command}\` is not on your PATH)`);
    }
    const mode = p.mode ?? 'terminal';
    if (mode === 'rich' && def.integration !== 'claude') throw new Error(`Rich view needs Claude for now (${def.label} runs in the terminal)`);
    const loc = await locate(cwd);
    const id = shortId();
    const repoName = basename(loc.worktree ?? loc.repoRoot);
    const defaultName = this.uniqueName(p.agent === 'shell' ? `${repoName} shell` : repoName);
    const row: SessionRow = {
      id, tmux_name: mode === 'rich' ? `r-${id}` : `j-${id}`, name: (p.name || '').trim() || defaultName, agent: p.agent,
      model: def.command ? p.model || null : null,
      agent_session_id: def.sessionIdArgs || mode === 'rich' ? randomUUID() : null, cwd, repo_root: loc.repoRoot,
      worktree: loc.worktree, hidden: 0, status: 'running', created_at: Date.now(), exited_at: null,
      sort_order: this.o.db.nextOrder(), mode, permission_mode: mode === 'rich' ? p.permissionMode ?? null : null,
    };
    if (mode === 'rich') await this.startRich(row, false);
    else await this.startTmux(row, { resume: false, extraArgs: p.extraArgs });
    this.o.db.insertSession(row);
    this.o.observers.setCwd(id, cwd);
    if (def.integration === 'codex') this.o.codex.track(id, cwd, Date.now());
    log(`created session ${id} (${row.agent}) in ${cwd}`);
    await this.poll();
    return this.toInfo(this.row(id));
  }

  /** "atlas", then "atlas 2", "atlas 3"… so sessions in one repo stay distinguishable. */
  private uniqueName(base: string): string {
    const taken = new Set(this.o.db.allSessions().map((r) => r.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  private async startRich(row: SessionRow, resume: boolean): Promise<void> {
    await this.o.rich.start({
      id: row.id, cwd: row.cwd, agentSessionId: row.agent_session_id!, resume, model: row.model, permissionMode: row.permission_mode,
    });
  }

  richHistory(id: string): { events: RichEnvelope[]; connected: boolean } {
    this.row(id);
    return { events: this.o.rich.history(id), connected: this.o.rich.connected(id) };
  }

  richSend(id: string, text: string): void {
    this.o.rich.send(id, text);
  }

  richInterrupt(id: string): void {
    this.o.rich.interrupt(id);
  }

  richRespond(id: string, requestId: string, behavior: 'allow' | 'deny', message?: string): void {
    this.o.rich.respond(id, requestId, behavior, message);
  }

  /** The thinking in this session's current Claude conversation, for the Thinking tab. */
  thinking(id: string): Promise<import('@jarvis/protocol').ThinkingList> {
    const r = this.row(id);
    return readThinking(r.agent_session_id ? findTranscript(r.agent_session_id) : null);
  }

  richInfo(id: string): Promise<RichInfo> {
    return this.o.rich.request<RichInfo>(id, 'info');
  }

  richConversations(id: string): Promise<RichConversation[]> {
    return this.o.rich.request<RichConversation[]>(id, 'conversations');
  }

  async richSetPermissionMode(id: string, mode: RichPermissionMode): Promise<void> {
    await this.o.rich.request(id, 'set_mode', { mode });
    this.o.db.updateSession(id, { permission_mode: mode });
  }

  /** /resume: point this session at another conversation and restart its host on it. */
  async richResume(id: string, agentSessionId: string): Promise<SessionInfo> {
    const r = this.row(id);
    if (r.mode !== 'rich') throw new Error('resume from the picker is for rich sessions; use /resume in the terminal');
    if (!/^[0-9a-f-]{36}$/i.test(agentSessionId)) throw new Error('not a Claude session id');
    await this.o.rich.stop(id);
    this.o.db.updateSession(id, { agent_session_id: agentSessionId, status: 'running', exited_at: null });
    this.o.observers.forget(id);
    await this.startRich(this.row(id), true);
    log(`rich ${id}: resumed conversation ${agentSessionId}`);
    await this.poll();
    return this.toInfo(this.row(id));
  }

  /** /export: the conversation as markdown in ~/Downloads (JARVIS_EXPORT_DIR in tests). */
  richExport(id: string): { path: string; markdown: string } {
    const r = this.row(id);
    const lines: string[] = [`# ${r.name}`, '', `Exported from Jarvis on ${new Date().toLocaleString()}. Claude conversation \`${r.agent_session_id}\` in \`${r.cwd}\`.`, ''];
    let speaker = '';
    const say = (who: string) => {
      if (speaker !== who) lines.push(`## ${who}`, '');
      speaker = who;
    };
    for (const { event: e } of this.o.rich.history(id)) {
      if (e.kind === 'user') { say('You'); lines.push(e.text, ''); }
      else if (e.kind === 'text' && !e.parentToolUseId) { say('Claude'); lines.push(e.text, ''); }
      else if (e.kind === 'tool_start' && !e.parentToolUseId) {
        say('Claude');
        const i = (e.input ?? {}) as Record<string, unknown>;
        const arg = String(i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? '').split('\n')[0]?.slice(0, 200) ?? '';
        lines.push(`- \`${e.tool}\`${arg ? ` ${arg}` : ''}`, '');
      }
    }
    const markdown = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
    const dir = process.env.JARVIS_EXPORT_DIR || join(homedir(), 'Downloads');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const path = join(dir, `${r.name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'conversation'}-${stamp}.md`);
    writeFileSync(path, markdown);
    return { path, markdown };
  }

  /**
   * Move a Claude session between Claude Code's own screen and the rich view. The conversation is Claude's
   * transcript, so each side resumes it by id; only one side runs at a time. With `command`, the terminal
   * side types that slash command once Claude Code is ready (for commands that need its screen).
   */
  async switchMode(id: string, mode: SessionMode, command: string | null = null): Promise<SessionInfo> {
    const r = this.row(id);
    const def = this.o.agents.get(r.agent);
    if (def.integration !== 'claude') throw new Error(`${def.label} has no rich view`);
    if (r.mode !== mode) {
      const resume = !!r.agent_session_id && claudeTranscriptExists(r.agent_session_id);
      if (mode === 'terminal') {
        await this.o.rich.stop(id);
        this.o.db.updateSession(id, { mode: 'terminal', tmux_name: `j-${id}`, status: 'running', exited_at: null });
        const extraArgs = r.permission_mode ? ['--permission-mode', r.permission_mode] : [];
        await this.startTmux(this.row(id), { resume, extraArgs });
      } else {
        if (this.live.has(r.tmux_name)) {
          await this.o.tmux.run(['kill-session', '-t', Tmux.target(r.tmux_name)]).catch(() => {});
          await new Promise((res) => setTimeout(res, 600)); // let Claude Code finish writing its transcript
        }
        if (!r.agent_session_id) this.o.db.updateSession(id, { agent_session_id: randomUUID() });
        this.o.db.updateSession(id, { mode: 'rich', tmux_name: `r-${id}`, status: 'running', exited_at: null });
        await this.startRich(this.row(id), resume);
      }
      this.o.observers.forget(id);
      log(`session ${id}: switched to ${mode} (resume=${resume})`);
      await this.poll();
    }
    if (command && mode === 'terminal') void this.typeWhenReady(this.row(id).tmux_name, command);
    return this.toInfo(this.row(id));
  }

  /** Wait for Claude Code's input box, then type a command into it. */
  private async typeWhenReady(tmuxName: string, command: string): Promise<void> {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const screen = await this.o.tmux.run(['capture-pane', '-p', '-t', Tmux.paneTarget(tmuxName)]).catch(() => '');
      // The empty input line is the one sign that holds in every permission mode (the footer text varies).
      if (/^\s*❯\s*$/m.test(screen) || /shift\+tab|\? for shortcuts/i.test(screen)) {
        await this.o.tmux.run(['send-keys', '-t', Tmux.paneTarget(tmuxName), '-l', command]);
        await new Promise((res) => setTimeout(res, 150));
        await this.o.tmux.run(['send-keys', '-t', Tmux.paneTarget(tmuxName), 'Enter']);
        return;
      }
      await new Promise((res) => setTimeout(res, 400));
    }
    logError(`could not type ${command} into ${tmuxName}: Claude Code did not become ready`);
  }

  private async startTmux(row: SessionRow, opts: { resume: boolean; extraArgs?: string[] }): Promise<void> {
    const t = this.o.tmux;
    const args = ['new-session', '-d', '-s', row.tmux_name, '-c', row.cwd, '-x', '200', '-y', '50',
      '-e', `JARVIS_SESSION=${row.id}`, '-e', `JARVIS_SOCKET=${this.o.socketPath}`];
    const cmd = buildAgentCommand(this.o.agents.get(row.agent), row, { ...opts, claudeSettings: this.o.claudeSettings });
    if (cmd) {
      // Run the agent through an interactive login shell so PATH and rc files apply, then drop into a
      // normal shell when it exits instead of ending the session.
      const shell = userShell();
      args.push(`${shellQuote(shell)} -l -i -c ${shellQuote(`${cmd}; exec ${shellQuote(shell)} -l`)}`);
    }
    await t.run(args);
    try {
      // Session options take a pane-style target, so the exact-match form needs the trailing colon.
      await t.run(['set-option', '-t', Tmux.paneTarget(row.tmux_name), '@jarvis_id', row.id]);
    } catch (e) {
      await t.run(['kill-session', '-t', Tmux.target(row.tmux_name)]).catch(() => {});
      throw e;
    }
  }

  async revive(id: string): Promise<SessionInfo> {
    const r = this.row(id);
    if (r.mode === 'rich') {
      if (!this.o.rich.connected(id)) {
        const resume = !!r.agent_session_id && claudeTranscriptExists(r.agent_session_id);
        await this.startRich(r, resume);
        this.o.db.updateSession(id, { status: 'running', exited_at: null });
        this.o.observers.forget(id);
        log(`revived rich session ${id} (resume=${resume})`);
      }
      await this.poll();
      return this.toInfo(this.row(id));
    }
    if (this.live.has(r.tmux_name)) return this.toInfo(r);
    const def = this.o.agents.get(r.agent);
    // Claude only writes a transcript after the first message; without one, --resume would fail, so start
    // fresh under the same pinned id instead.
    const resume = !!def.resumeArgs && !!r.agent_session_id &&
      (r.agent !== 'claude' || claudeTranscriptExists(r.agent_session_id));
    await this.startTmux(r, { resume });
    this.o.db.updateSession(id, { status: 'running', exited_at: null });
    this.o.observers.forget(id);
    if (def.integration === 'codex') this.o.codex.track(id, r.cwd, Date.now());
    log(`revived session ${id} (resume=${resume})`);
    await this.poll();
    return this.toInfo(this.row(id));
  }

  async kill(id: string): Promise<void> {
    const r = this.row(id);
    if (r.mode === 'rich') await this.o.rich.stop(id);
    else await this.o.tmux.run(['kill-session', '-t', Tmux.target(r.tmux_name)]).catch(() => {});
    await this.poll();
  }

  async remove(id: string): Promise<void> {
    const r = this.o.db.getSession(id);
    if (!r) return;
    if (r.mode === 'rich') await this.o.rich.stop(id);
    else await this.o.tmux.run(['kill-session', '-t', Tmux.target(r.tmux_name)]).catch(() => {});
    this.o.db.deleteSession(id);
    this.o.observers.deleteSession(id);
    this.o.codex.untrack(id);
    log(`removed session ${id}`);
    await this.poll();
  }

  rename(id: string, name: string): void {
    this.row(id);
    this.o.db.updateSession(id, { name: name.trim() || this.row(id).name });
    this.publish();
  }

  setHidden(id: string, hidden: boolean): void {
    this.row(id);
    this.o.db.updateSession(id, { hidden: hidden ? 1 : 0 });
    this.publish();
  }

  /** Move a session up/down within its workspace. */
  move(id: string, delta: number): void {
    const r = this.row(id);
    const peers = this.o.db.allSessions().filter((x) => x.repo_root === r.repo_root);
    const i = peers.findIndex((x) => x.id === id);
    const j = Math.max(0, Math.min(peers.length - 1, i + delta));
    const other = peers[j];
    if (i === j || !other) return;
    this.o.db.updateSession(r.id, { sort_order: other.sort_order });
    this.o.db.updateSession(other.id, { sort_order: r.sort_order });
    this.publish();
  }

  /** How a client attaches a terminal to a session. */
  attachSpec(id: string): AttachSpec {
    if (id.startsWith('ext:')) {
      const name = id.slice(4);
      const t = this.o.externalTmux ?? this.o.tmux;
      return { file: t.bin, args: ['-u', 'attach-session', '-t', Tmux.target(name)] };
    }
    const r = this.row(id);
    if (r.mode === 'rich') throw new Error(`${r.name} runs in the rich view; open it in Jarvis`);
    if (!this.live.has(r.tmux_name)) throw new Error(`session ${id} is not running`);
    return { file: this.o.tmux.bin, args: [...this.o.tmux.baseArgs(), 'attach-session', '-t', Tmux.target(r.tmux_name)] };
  }

  private tmuxFor(id: string): { t: Tmux; name: string } {
    if (id.startsWith('ext:')) return { t: this.o.externalTmux ?? this.o.tmux, name: id.slice(4) };
    const r = this.row(id);
    if (r.mode === 'rich') throw new Error(`${r.name} runs in the rich view, which has no terminal`);
    return { t: this.o.tmux, name: r.tmux_name };
  }

  async sendKeys(id: string, text: string, enter = false): Promise<void> {
    const { t, name } = this.tmuxFor(id);
    if (text) await t.run(['send-keys', '-t', Tmux.paneTarget(name), '-l', text]);
    if (enter) await t.run(['send-keys', '-t', Tmux.paneTarget(name), 'Enter']);
  }

  async capture(id: string, lines = 200): Promise<string> {
    const { t, name } = this.tmuxFor(id);
    return t.run(['capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', Tmux.paneTarget(name)]);
  }

  async split(id: string, direction: 'horizontal' | 'vertical'): Promise<void> {
    const { t, name } = this.tmuxFor(id);
    await t.run(['split-window', direction === 'horizontal' ? '-h' : '-v', '-t', Tmux.paneTarget(name), '-c', '#{pane_current_path}']);
  }

  async selectPane(id: string, dir: 'left' | 'right' | 'up' | 'down'): Promise<void> {
    const { t, name } = this.tmuxFor(id);
    const flag = { left: '-L', right: '-R', up: '-U', down: '-D' }[dir];
    await t.run(['select-pane', '-t', Tmux.paneTarget(name), flag]);
  }

  async zoom(id: string): Promise<void> {
    const { t, name } = this.tmuxFor(id);
    await t.run(['resize-pane', '-Z', '-t', Tmux.paneTarget(name)]);
  }

  async clearHistory(id: string): Promise<void> {
    const { t, name } = this.tmuxFor(id);
    await t.run(['clear-history', '-t', Tmux.paneTarget(name)]);
  }

  async copyMode(id: string): Promise<void> {
    const { t, name } = this.tmuxFor(id);
    await t.run(['copy-mode', '-t', Tmux.paneTarget(name)]);
  }

  async mouseState(id: string): Promise<{ appMouse: boolean }> {
    const { t, name } = this.tmuxFor(id);
    const out = await t.run(['display-message', '-p', '-t', Tmux.paneTarget(name), '#{mouse_any_flag}']).catch(() => '');
    return { appMouse: out.trim() === '1' };
  }

  /** Paste text into the agent's input (bracketed paste, so newlines don't submit). Used for quote-replies. */
  async paste(id: string, text: string): Promise<void> {
    const { t, name } = this.tmuxFor(id);
    await t.run(['copy-mode', '-q', '-t', Tmux.paneTarget(name)]).catch(() => {});
    await t.runInput(['load-buffer', '-b', 'jarvis-paste', '-'], text);
    await t.run(['paste-buffer', '-p', '-d', '-b', 'jarvis-paste', '-t', Tmux.paneTarget(name)]);
  }

  /** The newest tmux paste buffer: what the user last selected with the mouse in tmux. */
  async lastBuffer(id: string): Promise<{ name: string | null; created: number | null; text: string | null }> {
    const { t } = this.tmuxFor(id);
    const out = await t.run(['list-buffers', '-F', '#{buffer_created}\t#{buffer_name}']).catch(() => '');
    const newest = out.split('\n').filter(Boolean).map((l) => l.split('\t')).sort((a, b) => Number(b[0]) - Number(a[0]))[0];
    if (!newest?.[1] || newest[1] === 'jarvis-paste') return { name: null, created: null, text: null };
    const text = await t.run(['show-buffer', '-b', newest[1]]).catch(() => null);
    return { name: newest[1], created: Number(newest[0]) * 1000, text };
  }

  activity(id: string, limit?: number): ActivityEntry[] {
    return this.o.observers.list(id, limit);
  }

  touched(id: string): string[] {
    return this.o.observers.touched(id);
  }

  filesList(root: string): Promise<{ root: string; files: FileEntry[]; truncated: boolean }> {
    return listFiles(root).then((r) => ({ root, ...r }));
  }

  filesRead(path: string): FileContent {
    return readFile(path.replace(/^~(?=$|\/)/, homedir()));
  }

  filesChanges(root: string): Promise<ChangedFile[]> {
    return fileChanges(root);
  }

  async filesDiff(root: string, path: string): Promise<string> {
    return fileDiff(root, path);
  }

  filesWatch(root: string): void {
    this.o.files.watch(root);
  }

  docs(id: string): DocEntry[] {
    const r = this.row(id);
    const l = this.live.get(r.tmux_name);
    return listDocs(l?.currentPath || r.cwd, r.worktree ?? r.repo_root, this.o.observers.touched(id));
  }

  connectors(id: string): Connector[] {
    const r = this.row(id);
    return listConnectors(r.agent, r.cwd, r.repo_root, this.o.usage.recentServers(30));
  }

  checkConnectors(id: string): Promise<string> {
    const r = this.row(id);
    return checkConnectors(r.agent, r.cwd, this.o.env);
  }

  private knownRoots: string[] = [];
  private knownRootsAt = 0;

  /** Longest known repo root containing `cwd`, so usage rolls up from subfolders and worktrees to the repo. */
  resolveProject(cwd: string): string {
    if (Date.now() - this.knownRootsAt > 300_000) {
      const roots = new Set<string>();
      for (const root of this.o.repoRoots) for (const p of scanRepos(root)) roots.add(p);
      for (const r of this.o.db.allSessions()) roots.add(r.repo_root);
      this.knownRoots = [...roots].sort((a, b) => b.length - a.length);
      this.knownRootsAt = Date.now();
    }
    return this.knownRoots.find((r) => cwd === r || cwd.startsWith(`${r}/`)) ?? cwd;
  }

  refreshPrs() {
    return this.o.prs.refresh();
  }

  limits(): UsageSummary['limits'] {
    const c = this.o.observers.claudeLimits;
    return {
      claude: {
        fiveHour: c.fiveHour ? { ...c.fiveHour, windowMinutes: 300 } : null,
        sevenDay: c.sevenDay ? { ...c.sevenDay, windowMinutes: 10080 } : null,
        asOf: c.asOf,
      },
      codex: this.o.usage.codexLimits,
    };
  }

  usageSummary(days = 30): UsageSummary {
    const l = this.limits();
    return this.o.usage.summary(days, l.claude);
  }

  /** Open a file in the user's editor at a line: VS Code / Cursor CLI if present, else macOS default. */
  openEditor(path: string, line?: number): void {
    const code = findBinary('code', this.o.env) ?? findBinary('cursor', this.o.env);
    if (code) execFile(code, ['-g', line ? `${path}:${line}` : path], { env: this.o.env });
    else execFile('open', [path]);
  }

  /** Enter tmux copy mode and open its backward search prompt. */
  async search(id: string): Promise<void> {
    const { t, name } = this.tmuxFor(id);
    await t.run(['copy-mode', '-t', Tmux.paneTarget(name)]);
    await t.run(['command-prompt', '-t', Tmux.paneTarget(name), '-T', 'search', '-p', '(search up)',
      'send-keys -X search-backward-incremental "%%"']);
  }

  /** Best guess at which agent an external tmux pane is running (Claude's binary reports its version as the name). */
  private guessAgent(cmd: string): string {
    if (/^\d+\.\d+\.\d+$/.test(cmd) || /claude/i.test(cmd)) return 'claude';
    const hit = this.o.agents.list().find((a) => a.command && cmd === a.command.split('/').pop());
    return hit?.id ?? 'shell';
  }

  async agentsList(refresh = false): Promise<AgentDef[]> {
    const list = await this.o.agents.refresh(refresh);
    this.publish();
    return list;
  }

  async repos(): Promise<RepoCandidate[]> {
    const lastUsed = this.o.db.lastUsedByCwd();
    const seen = new Set<string>();
    const out: RepoCandidate[] = [];
    const roots = new Set<string>();
    for (const root of this.o.repoRoots) for (const p of scanRepos(root)) roots.add(p);
    for (const r of this.o.db.allSessions()) if (existsSync(r.repo_root)) roots.add(r.repo_root);
    const lists = await Promise.all([...roots].map(async (repo) => ({ repo, wts: await listWorktrees(repo) })));
    for (const { repo, wts } of lists) {
      const entries = wts.length ? wts : [{ path: repo, branch: null }];
      const main = entries[0]?.path ?? repo;
      for (const w of entries) {
        if (seen.has(w.path)) continue;
        seen.add(w.path);
        const isWorktree = w.path !== main;
        out.push({
          path: w.path, name: isWorktree ? `${basename(main)}/${basename(w.path)}` : basename(w.path),
          repoRoot: main, branch: w.branch, isWorktree, lastUsed: lastUsed.get(w.path) ?? null,
        });
      }
    }
    // Recently used non-git directories.
    for (const [cwd, t] of lastUsed) {
      if (!seen.has(cwd) && existsSync(cwd)) {
        seen.add(cwd);
        out.push({ path: cwd, name: basename(cwd) || cwd, repoRoot: cwd, branch: null, isWorktree: false, lastUsed: t });
      }
    }
    out.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || Number(a.isWorktree) - Number(b.isWorktree) || a.name.localeCompare(b.name));
    return out;
  }
}


