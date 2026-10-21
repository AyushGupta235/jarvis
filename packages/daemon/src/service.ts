import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  ActivityEntry, AgentDef, AttachSpec, ChangedFile, Connector, CreateSessionParams, DaemonInfo, DocEntry, FileContent,
  FileEntry, RepoCandidate, SessionInfo, Snapshot, UsageSummary, WorkspaceInfo,
} from '@jarvis/protocol';
import { execFile } from 'node:child_process';
import { fill, type AgentRegistry } from './agents';
import type { Observers } from './observers';
import type { CodexObserver } from './codex';
import type { UsageIndexer } from './usage';
import type { PrTracker, RemoteCache } from './prs';
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
    for (const r of o.db.allSessions()) {
      o.observers.setCwd(r.id, r.cwd);
      if (this.o.agents.list().find((a) => a.id === r.agent)?.integration === 'codex' && r.status === 'running') {
        o.codex.track(r.id, r.cwd, r.created_at);
      }
    }
  }

  start(): void {
    void this.poll();
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
      await this.reconcile();
      this.publish();
    } catch (e) {
      logError('poll failed', e);
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
      const alive = this.live.has(r.tmux_name);
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
        status: 'running', created_at: s.created || now, exited_at: null, sort_order: db.nextOrder(),
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
    return { daemon: this.o.info, agents: this.o.agents.list(), prs: this.o.prs.state, limits: this.limits(), sessions, workspaces: [...wsMap.values()] };
  }

  private toInfo(r: SessionRow): SessionInfo {
    const l = this.live.get(r.tmux_name);
    const path = l?.currentPath || r.cwd;
    return {
      id: r.id, tmuxName: r.tmux_name, name: r.name, agent: r.agent, model: r.model,
      agentSessionId: r.agent_session_id, cwd: r.cwd, currentPath: l?.currentPath ?? null,
      repoRoot: r.repo_root, worktree: r.worktree, branch: this.branches.get(path), hidden: !!r.hidden,
      status: l ? 'running' : 'exited', createdAt: r.created_at, exitedAt: r.exited_at,
      lastActivity: l?.activity ?? null, attachedClients: l?.attached ?? 0, paneCommand: l?.currentCommand ?? null,
      panePid: l?.panePid ?? null, external: false, order: r.sort_order,
      agentState: this.o.observers.state(r.id),
      pr: this.o.prs.forBranch(this.o.remotes.get(r.repo_root), this.branches.get(path)),
    };
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
    const loc = await locate(cwd);
    const id = shortId();
    const repoName = basename(loc.worktree ?? loc.repoRoot);
    const defaultName = this.uniqueName(p.agent === 'shell' ? `${repoName} shell` : repoName);
    const row: SessionRow = {
      id, tmux_name: `j-${id}`, name: (p.name || '').trim() || defaultName, agent: p.agent,
      model: def.command ? p.model || null : null,
      agent_session_id: def.sessionIdArgs ? randomUUID() : null, cwd, repo_root: loc.repoRoot,
      worktree: loc.worktree, hidden: 0, status: 'running', created_at: Date.now(), exited_at: null,
      sort_order: this.o.db.nextOrder(),
    };
    await this.startTmux(row, { resume: false, extraArgs: p.extraArgs });
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
    await this.o.tmux.run(['kill-session', '-t', Tmux.target(r.tmux_name)]).catch(() => {});
    await this.poll();
  }

  async remove(id: string): Promise<void> {
    const r = this.o.db.getSession(id);
    if (!r) return;
    await this.o.tmux.run(['kill-session', '-t', Tmux.target(r.tmux_name)]).catch(() => {});
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
    if (!this.live.has(r.tmux_name)) throw new Error(`session ${id} is not running`);
    return { file: this.o.tmux.bin, args: [...this.o.tmux.baseArgs(), 'attach-session', '-t', Tmux.target(r.tmux_name)] };
  }

  private tmuxFor(id: string): { t: Tmux; name: string } {
    if (id.startsWith('ext:')) return { t: this.o.externalTmux ?? this.o.tmux, name: id.slice(4) };
    return { t: this.o.tmux, name: this.row(id).tmux_name };
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


