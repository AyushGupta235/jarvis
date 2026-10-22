/**
 * jarvis-agent-host: runs one rich Claude session through the Agent SDK and serves it on a unix socket.
 *
 * jarvisd spawns one per rich session, detached, the way tmux holds terminal sessions: quitting Jarvis or
 * restarting jarvisd leaves it running, and jarvisd reconnects. The conversation itself lives in Claude's
 * own transcript (~/.claude/projects), so after a reboot a new host resumes it by session id.
 *
 * Protocol: newline-delimited JSON. Client ops: sub {since}, send {text}, interrupt, respond
 * {requestId, behavior, message?}, close, and requests with a reqId (info, conversations, set_mode) that get
 * a reply {reqId, result | error}. Host ops: hello {pid, agentSessionId, seq}, events {list}, ev {env}, bye {reason}.
 */
import { forkSession, listSessions, query, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { RICH_HOST_PROTOCOL } from '@jarvis/protocol';
import { readChain, type Chain } from './transcript';
import { COMPACT_SUMMARY_PREFIX, parseAgentMessage, parseTaskNotification, userText } from './notices';
import { findTranscript } from './thinking';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { RichContext, RichConversation, RichEnvelope, RichEvent, RichInfo, RichQuestion } from '@jarvis/protocol';
import type { RichHostConfig, RichHostMeta } from '@jarvis/protocol/node';

const cfg = JSON.parse(process.env.JARVIS_HOST_CONFIG ?? 'null') as RichHostConfig | null;
if (!cfg) {
  console.error('JARVIS_HOST_CONFIG is not set');
  process.exit(2);
}
delete process.env.JARVIS_HOST_CONFIG;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Test hook (e2e/rich-extras): when this marker file exists, act as an old host once, so that "restart" can be tested. */
function reportedProto(): number {
  const marker = process.env.JARVIS_TEST_OLD_HOST_MARKER;
  if (marker && existsSync(marker)) {
    try { unlinkSync(marker); } catch { /* gone */ }
    return 0;
  }
  return RICH_HOST_PROTOCOL;
}

// ---- event log ----

/** Everything this host has shown, for clients that (re)connect. History older than the host comes from the transcript. */
const events: RichEnvelope[] = [];
const MAX_EVENTS = 20_000;
let seq = 0;
const clients = new Set<Socket>();

function send(c: Socket, msg: unknown): void {
  if (!c.destroyed) c.write(`${JSON.stringify(msg)}\n`);
}

function push(event: RichEvent, replay = false): void {
  const env: RichEnvelope = { seq: ++seq, ts: Date.now(), event, ...(replay ? { replay: true } : {}) };
  events.push(env);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  for (const c of clients) send(c, { op: 'ev', env });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : JSON.stringify(b))).join('\n');
}

/** Turn one API message (live or from the transcript) into events. */
function fromMessage(role: 'user' | 'assistant', message: any, parentToolUseId: string | null, replay: boolean): void {
  const content = message?.content;
  if (!replay && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'tool_use') runningTools++;
      else if (b?.type === 'tool_result') runningTools = Math.max(0, runningTools - 1);
    }
  }
  if (role === 'user') {
    // Messages Claude Code writes itself: a background task reporting in, and the summary after a compaction.
    const text = parentToolUseId ? null : userText(content);
    const notice = text ? parseTaskNotification(text) ?? parseAgentMessage(text) : null;
    if (notice) {
      // Live, the SDK already told us this with a structured message (see announced); don't show it twice.
      if (!replay && announced.has(`${notice.taskId}:${notice.status}`)) return;
      push(notice, replay);
      return;
    }
    if (text?.startsWith(COMPACT_SUMMARY_PREFIX)) {
      push({ kind: 'compact_summary', text }, replay);
      return;
    }
    if (typeof content === 'string') {
      if (replay) push({ kind: 'user', text: content }, true);
      return;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'tool_result') push({ kind: 'tool_end', toolUseId: b.tool_use_id, output: textOf(b.content), isError: !!b.is_error }, replay);
      else if (b?.type === 'text' && replay && !parentToolUseId) push({ kind: 'user', text: b.text }, true);
    }
    return;
  }
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === 'text' && b.text) push({ kind: 'text', text: b.text, parentToolUseId }, replay);
    else if (b?.type === 'thinking' && b.thinking) push({ kind: 'thinking', text: b.thinking, parentToolUseId }, replay);
    else if (b?.type === 'tool_use' || b?.type === 'server_tool_use' || b?.type === 'mcp_tool_use') {
      push({ kind: 'tool_start', toolUseId: b.id, tool: b.name, input: b.input ?? null, parentToolUseId }, replay);
    }
  }
}

/** Task reports already shown from the SDK's own structured messages: taskId:status. */
const announced = new Set<string>();

type TaskPatch = Partial<Pick<Extract<RichEvent, { kind: 'task' }>, 'description' | 'agentType' | 'tools' | 'tokens' | 'durationMs' | 'lastTool' | 'progress' | 'background'>>;

/** Sub-agent and background-command progress, one event per change (the view keeps the latest per tool call). */
function pushTask(taskId: string, toolUseId: string | null, state: Extract<RichEvent, { kind: 'task' }>['state'], p: TaskPatch): void {
  push({
    kind: 'task', taskId, toolUseId, state, description: p.description ?? null, agentType: p.agentType ?? null, tools: p.tools ?? null,
    tokens: p.tokens ?? null, durationMs: p.durationMs ?? null, lastTool: p.lastTool ?? null, progress: p.progress ?? null, background: !!p.background,
  });
}

/** Last time anything arrived from Claude; with the state below it tells a held queue that nothing is going to flush it. */
let lastActivity = Date.now();

function onSdkMessage(m: SDKMessage): void {
  lastActivity = Date.now();
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        log(`init: claude ${m.claude_code_version}, model ${m.model}, auth ${m.apiKeySource}, ${m.tools.length} tools`);
        info.model = m.model;
        info.permissionMode = m.permissionMode;
        info.version = m.claude_code_version;
        info.terminalCommands = m.terminal_slash_commands ?? info.terminalCommands;
        info.account = { ...(info.account ?? { email: null, organization: null, subscription: null }), authSource: m.apiKeySource };
        if (m.session_id && m.session_id !== currentSessionId) {
          // /clear starts a new conversation: follow it, so revive and /resume know which one is live.
          log(`session id changed: ${currentSessionId} -> ${m.session_id}`);
          currentSessionId = m.session_id;
          writeMeta();
        }
        pushStatus();
      } else if (m.subtype === 'compact_boundary') {
        const c = m.compact_metadata;
        push({ kind: 'compact', trigger: c?.trigger, preTokens: c?.pre_tokens, postTokens: c?.post_tokens, durationMs: c?.duration_ms });
      } else if (m.subtype === 'session_state_changed') {
        // The SDK's own word on whether a turn is running. Idle means anything held can go now.
        if (m.state === 'running') turnActive = true;
        else if (m.state === 'idle') {
          turnActive = false;
          for (const [, v] of unread) v.queued = false;
          if (held.length && !paused) releaseAll(false);
        }
      } else if (m.subtype === 'status') {
        if (m.status === 'compacting') push({ kind: 'compacting' });
        else if (m.compact_result === 'failed') push({ kind: 'compact', error: m.compact_error ?? 'compaction failed' });
      } else if (m.subtype === 'task_started') {
        foreground.add(m.task_id);
        onTaskStarted?.();
        pushTask(m.task_id, m.tool_use_id ?? null, 'running', { description: m.description, agentType: m.subagent_type ?? null, background: !!m.is_backgrounded });
      } else if (m.subtype === 'task_progress') {
        pushTask(m.task_id, m.tool_use_id ?? null, 'running', {
          description: m.description, agentType: m.subagent_type ?? null, tools: m.usage?.tool_uses ?? null, tokens: m.usage?.total_tokens ?? null,
          durationMs: m.usage?.duration_ms ?? null, lastTool: m.last_tool_name ?? null, progress: m.summary ?? null,
        });
      } else if (m.subtype === 'task_updated' && (m as { patch?: { is_backgrounded?: boolean } }).patch?.is_backgrounded) {
        foreground.delete(m.task_id);
        pushTask(m.task_id, (m as { tool_use_id?: string }).tool_use_id ?? null, 'running', { background: true });
      } else if (m.subtype === 'task_notification') {
        foreground.delete(m.task_id);
        const status = m.status === 'completed' ? 'completed' : m.status === 'failed' ? 'failed' : 'stopped';
        announced.add(`${m.task_id}:${status}`);
        push({ kind: 'task_notice', taskId: m.task_id, toolUseId: m.tool_use_id ?? null, status, summary: m.summary, event: null });
        pushTask(m.task_id, m.tool_use_id ?? null, m.status === 'completed' ? 'done' : m.status === 'failed' ? 'failed' : 'stopped', {
          progress: m.summary, tools: m.usage?.tool_uses ?? null, tokens: m.usage?.total_tokens ?? null, durationMs: m.usage?.duration_ms ?? null,
        });
      }
      return;
    case 'assistant': {
      const stamped = [m.user_message_uuid, ...(m.user_message_uuids ?? [])].filter((u): u is string => !!u);
      if (stamped.length) markRead(stamped);
      else if (!m.parent_tool_use_id) foldQueued();
      fromMessage('assistant', m.message, m.parent_tool_use_id, false);
      return;
    }
    case 'user':
      if (!m.parent_tool_use_id && Array.isArray((m.message as { content?: unknown }).content)) {
        if (RELEASE === 'next-step' && held.length && !paused) releaseAll(true);
        foldQueued();
      }
      fromMessage('user', m.message, m.parent_tool_use_id, false);
      return;
    case 'rate_limit_event': {
      const info = m.rate_limit_info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>; rateLimitType?: string; utilization?: number; resetsAt?: number };
      const win = (name: string, type: string) => {
        const w = info.unifiedWindows?.[name] ?? (info.rateLimitType === type ? info : undefined);
        return w && typeof w.utilization === 'number' ? { usedPct: Math.round(w.utilization * 1000) / 10, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null } : null;
      };
      const fiveHour = win('five_hour', 'five_hour');
      const sevenDay = win('seven_day', 'seven_day');
      if (fiveHour || sevenDay) push({ kind: 'limits', at: Date.now(), fiveHour, sevenDay });
      return;
    }
    case 'result':
      turnActive = unread.size > 0; // anything still unread starts the next turn
      for (const [, v] of unread) v.queued = false;
      if (held.length) {
        if (paused) push({ kind: 'queue', action: 'paused' });
        else releaseAll(false);
      }
      void reportContext();
      {
        const stopped = stopRequested && m.subtype !== 'success';
        stopRequested = false;
        push({
          kind: 'turn_end', ok: m.subtype === 'success' || stopped, durationMs: m.duration_ms ?? null, costUsd: m.total_cost_usd ?? null,
          error: m.subtype === 'success' || stopped ? null : ('errors' in m && m.errors?.length ? m.errors.join('; ') : m.subtype),
          ...(stopped ? { stopped: true } : {}),
        });
      }
      return;
    default:
      return;
  }
}

// ---- input and permissions ----

/** User messages for the long-lived query, as an async iterable the SDK pulls from. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(text: string, uuid: string): void {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: uuid as `${string}-${string}-${string}-${string}-${string}` });
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.done) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

const inbox = new Inbox();

/**
 * Messages you sent that Claude hasn't read yet. A message sent mid-turn is queued; Claude Code folds it in at
 * the next tool result (or starts a new turn with it), and the SDK stamps the uuid on the reply that answers it.
 */
let turnActive = false;

/**
 * Commands Claude Code has registered as tasks that Ctrl+B could move to the background. A command registers a
 * few seconds after it starts, and backgroundTasks() before that returns true but does nothing; so a Ctrl+B
 * pressed early waits for the registration.
 */
const foreground = new Set<string>();
let onTaskStarted: (() => void) | null = null;
let runningTools = 0;

async function backgroundNow(): Promise<boolean> {
  if (!foreground.size && runningTools > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      onTaskStarted = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    onTaskStarted = null;
  }
  return foreground.size ? q!.backgroundTasks() : false;
}
const unread = new Map<string, { sentAt: number; queued: boolean }>();

/**
 * Messages sent while a turn runs wait here, in Jarvis, so you can edit one, remove one, or send one now. They go to
 * Claude when the turn ends ('turn-end', the default) or at its next tool boundary ('next-step', which is how Claude
 * Code's own terminal folds them in). Stopping a turn holds what is left until you decide.
 */
interface Held { uuid: string; text: string }
const held: Held[] = [];
const RELEASE: 'turn-end' | 'next-step' = process.env.JARVIS_QUEUE_RELEASE === 'next-step' ? 'next-step' : 'turn-end';
let paused = false;
/** You pressed stop (or Send now) and the turn has not ended yet: its ending is not a failure. */
let stopRequested = false;

/** Hand a held message to Claude. `midTurn`: it folds into the running turn; otherwise it starts the next one. */
function release(h: Held, midTurn: boolean): void {
  unread.set(h.uuid, { sentAt: Date.now(), queued: midTurn });
  push({ kind: 'queue', action: 'release', uuid: h.uuid, midTurn });
  if (!midTurn) turnActive = true;
  inbox.push(h.text, h.uuid);
}

function releaseAll(midTurn: boolean): void {
  for (const h of held.splice(0)) release(h, midTurn);
  paused = false;
}

function queueOp(op: string, msg: { uuid?: string; text?: string }): { ok: boolean; reason?: string } {
  const i = held.findIndex((h) => h.uuid === msg.uuid);
  if (i < 0) return { ok: false, reason: 'Claude already has this message' };
  const h = held[i]!;
  if (op === 'queue_edit') {
    const text = String(msg.text ?? '');
    if (!text.trim()) return { ok: false, reason: 'a message cannot be empty (remove it instead)' };
    h.text = text;
    push({ kind: 'queue', action: 'edit', uuid: h.uuid, text });
  } else if (op === 'queue_remove') {
    held.splice(i, 1);
    push({ kind: 'queue', action: 'remove', uuid: h.uuid });
    if (!held.length) paused = false;
  } else {
    // Send now: this message goes first and the running turn is stopped so Claude gets to it straight away.
    held.splice(i, 1);
    const busy = turnActive;
    release(h, false);
    if (busy) {
      stopRequested = true;
      void q?.interrupt().catch((e) => log('interrupt failed', e));
    }
    if (!held.length) paused = false;
  }
  return { ok: true };
}

function markRead(uuids: string[]): void {
  const hit = uuids.filter((u) => unread.delete(u));
  if (hit.length) push({ kind: 'user_read', uuids: hit });
}

/** Something from the agent arrived: anything queued before it has been folded into this turn. */
function foldQueued(): void {
  const now = Date.now();
  markRead([...unread.entries()].filter(([, m]) => m.queued && m.sentAt < now - 50).map(([u]) => u));
}

/** What the CLI reported at startup, plus what changes as the session runs (model, mode, session id after /clear). */
const info: RichInfo = {
  commands: [], terminalCommands: [], models: [], outputStyles: [], account: null, version: null, model: null, permissionMode: null,
};
let currentSessionId = cfg.agentSessionId;

function writeMeta(): void {
  const meta: RichHostMeta = { pid: process.pid, socketPath: cfg!.socketPath, agentSessionId: currentSessionId, startedAt };
  mkdirSync(dirname(cfg!.metaPath), { recursive: true });
  writeFileSync(cfg!.metaPath, JSON.stringify(meta));
}
const startedAt = Date.now();

function pushStatus(): void {
  push({ kind: 'status', model: info.model, permissionMode: info.permissionMode, agentSessionId: currentSessionId, cwd: cfg!.cwd, authSource: info.account?.authSource ?? null });
}
const pending = new Map<string, { input: Record<string, unknown>; resolve: (r: PermissionResult) => void }>();

/** The answer to a question card: allow the tool with the answers filled in, which is what Claude reads back. */
function answerQuestion(requestId: string, answers: Record<string, string | string[]>): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers } });
  push({ kind: 'permission_resolved', requestId, behavior: 'allow', answers });
}

function resolvePermission(requestId: string, behavior: 'allow' | 'deny', message?: string): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  p.resolve(behavior === 'allow'
    ? { behavior: 'allow', updatedInput: p.input }
    : { behavior: 'deny', message: message || 'The user denied this in Jarvis.' });
  push({ kind: 'permission_resolved', requestId, behavior });
}

// ---- socket server ----

function serve(): Promise<void> {
  mkdirSync(dirname(cfg!.socketPath), { recursive: true });
  if (existsSync(cfg!.socketPath)) unlinkSync(cfg!.socketPath);
  const server = createServer((c) => {
    clients.add(c);
    send(c, { op: 'hello', pid: process.pid, agentSessionId: cfg!.agentSessionId, seq, proto: reportedProto() });
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) handle(c, line);
      }
    });
    c.on('close', () => clients.delete(c));
    c.on('error', () => clients.delete(c));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg!.socketPath, () => resolve());
  });
}

let q: Query | null = null;

function handle(c: Socket, line: string): void {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.op) {
    case 'sub':
      send(c, { op: 'events', list: events.filter((e) => e.seq > (Number(msg.since) || 0)) });
      return;
    case 'send': {
      const text = String(msg.text ?? '');
      if (!text.trim()) return;
      const uuid = randomUUID();
      if (turnActive) {
        held.push({ uuid, text });
        push({ kind: 'user', text, uuid, queued: true });
        return;
      }
      turnActive = true;
      unread.set(uuid, { sentAt: Date.now(), queued: false });
      push({ kind: 'user', text, uuid });
      inbox.push(text, uuid);
      return;
    }
    case 'interrupt':
      // Stopping is not "send what I queued": what is left waits for you.
      if (held.length) paused = true;
      if (turnActive) stopRequested = true;
      void q?.interrupt().catch((e) => log('interrupt failed', e));
      return;
    case 'answer':
      answerQuestion(String(msg.requestId), msg.answers ?? {});
      return;
    case 'respond':
      resolvePermission(String(msg.requestId), msg.behavior === 'allow' ? 'allow' : 'deny', msg.message || (pending.get(String(msg.requestId))?.input.questions ? 'The user skipped this question.' : undefined));
      return;
    case 'close':
      void shutdown('closed from Jarvis');
      return;
    case 'queue_edit':
    case 'queue_remove':
    case 'queue_sendNow':
      send(c, { op: 'reply', reqId: msg.reqId, result: queueOp(msg.op === 'queue_sendNow' ? 'queue_send' : msg.op, msg) });
      return;
    case 'info':
    case 'context':
    case 'rewind_points':
    case 'fork':
    case 'conversations':
    case 'set_mode':
    case 'background':
      void request(msg.op, msg)
        .then((result) => send(c, { op: 'reply', reqId: msg.reqId, result }))
        .catch((e) => send(c, { op: 'reply', reqId: msg.reqId, error: (e as Error).message }));
      return;
    default:
      return;
  }
}

/** Context window use after each turn (the SDK has no status line); 'summary' costs no extra tokens. */
async function reportContext(): Promise<void> {
  try {
    const u = await q!.getContextUsage({ detail: 'summary' });
    if (u.maxTokens > 0) push({ kind: 'context', usedPct: u.percentage, usedTokens: u.totalTokens, windowTokens: u.maxTokens });
  } catch (e) {
    log('context usage failed', (e as Error).message);
  }
}

async function findAndRead(sessionId: string): Promise<Chain> {
  try {
    const path = findTranscript(sessionId);
    if (path) return await readChain(path);
  } catch (e) {
    log('could not read history', e);
  }
  return { entries: [], prompts: [], total: 0 };
}

async function request(op: string, msg: any): Promise<unknown> {
  switch (op) {
    case 'info':
      return info;
    case 'conversations': {
      const list = await listSessions({ dir: cfg!.cwd, limit: 60 });
      return list.map((x): RichConversation => ({
        agentSessionId: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || x.sessionId,
        firstPrompt: x.firstPrompt ?? null, lastModified: x.lastModified, sizeBytes: x.fileSize ?? null,
        branch: x.gitBranch ?? null, current: x.sessionId === currentSessionId,
      }));
    }
    case 'context': {
      if (!q) throw new Error('the session has not started yet');
      const u = await q.getContextUsage({ detail: 'full' });
      const byServer = new Map<string, { tools: number; tokens: number }>();
      for (const t of u.mcpTools) {
        const x = byServer.get(t.serverName) ?? { tools: 0, tokens: 0 };
        x.tools++;
        x.tokens += t.tokens;
        byServer.set(t.serverName, x);
      }
      const mb = u.messageBreakdown;
      const top = (list: { name: string; tokens: number }[]) => list.sort((a, b) => b.tokens - a.tokens).slice(0, 8);
      const out: RichContext = {
        model: u.model, totalTokens: u.totalTokens, maxTokens: u.maxTokens, percentage: u.percentage,
        autoCompactAt: u.isAutoCompactEnabled ? u.autoCompactThreshold ?? null : null,
        categories: u.categories.map((c) => ({ id: c.id ?? c.name, name: c.name, tokens: c.tokens, kind: c.kind })),
        mcp: [...byServer.entries()].map(([server, v]) => ({ server, ...v })).sort((a, b) => b.tokens - a.tokens),
        memoryFiles: u.memoryFiles.map((m) => ({ path: m.path, type: m.type, tokens: m.tokens })),
        agents: u.agents.map((a) => ({ name: a.agentType, source: a.source, tokens: a.tokens })).sort((a, b) => b.tokens - a.tokens),
        skills: (u.skills?.skillFrontmatter ?? []).map((s) => ({ name: s.name, source: s.pluginName ?? s.source, tokens: s.tokens })).sort((a, b) => b.tokens - a.tokens),
        messages: mb ? [
          { label: 'Tool results', tokens: mb.toolResultTokens }, { label: 'Tool calls', tokens: mb.toolCallTokens },
          { label: 'Claude replies', tokens: mb.assistantMessageTokens }, { label: 'Your messages', tokens: mb.userMessageTokens },
          { label: 'Attachments', tokens: mb.attachmentTokens },
        ].filter((m) => m.tokens > 0) : [],
        topTools: mb ? top(mb.toolCallsByType.map((t) => ({ name: t.name, tokens: t.callTokens + t.resultTokens }))) : [],
      };
      return out;
    }
    case 'rewind_points': {
      const chain = await findAndRead(currentSessionId);
      return chain.prompts.slice(-80).reverse().map((p) => ({ uuid: p.uuid, text: p.text.slice(0, 400), ts: p.ts, before: p.before }));
    }
    case 'fork': {
      // Copy the conversation up to (and including) one message into a new conversation; the original stays as it is.
      const r = await forkSession(currentSessionId, { dir: cfg!.cwd, upToMessageId: String(msg.upToMessageId), title: msg.title ? String(msg.title) : undefined });
      return { sessionId: r.sessionId };
    }
    case 'background':
      if (!q) throw new Error('the session has not started yet');
      return { backgrounded: await backgroundNow() };
    case 'set_mode': {
      if (!q) throw new Error('the session has not started yet');
      await q.setPermissionMode(msg.mode);
      info.permissionMode = msg.mode;
      pushStatus();
      return { ok: true };
    }
    default:
      throw new Error(`unknown request ${op}`);
  }
}

// ---- lifecycle ----

let stopping = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`shutting down: ${reason}`);
  push({ kind: 'ended', reason });
  for (const c of clients) send(c, { op: 'bye', reason });
  inbox.end();
  try {
    q?.close();
  } catch { /* already gone */ }
  try { unlinkSync(cfg!.metaPath); } catch { /* gone */ }
  try { unlinkSync(cfg!.socketPath); } catch { /* gone */ }
  setTimeout(() => process.exit(code), 300);
}

async function main(): Promise<void> {
  const c = cfg!;
  if (c.resume) {
    // The conversation so far, from Claude's transcript, so a revived session shows all of its history.
    const chain = await findAndRead(c.agentSessionId);
    if (chain.total > chain.entries.length) push({ kind: 'resumed', messages: chain.total, shown: chain.entries.length });
    for (const m of chain.entries) {
      if (m.type === 'compact') push({ kind: 'compact', ...m.compact }, true);
      else fromMessage(m.type, m.message, m.parentToolUseId, true);
    }
    if (chain.total <= chain.entries.length) push({ kind: 'resumed', messages: chain.total });
  }
  await serve();
  writeMeta();
  // A held message must never be stranded: if Claude has been quiet and nothing it is waiting on is pending, send them.
  setInterval(() => {
    if (held.length && !paused && turnActive && pending.size === 0 && runningTools === 0 && Date.now() - lastActivity > 15_000) {
      log('releasing held messages: no turn is running');
      turnActive = false;
      releaseAll(false);
    }
  }, 2000).unref();
  log(`host ${process.pid} for ${c.id} on ${c.socketPath} (${c.resume ? 'resume' : 'new'} ${c.agentSessionId})`);

  q = query({
    prompt: inbox,
    options: {
      cwd: c.cwd,
      ...(c.resume ? { resume: c.agentSessionId } : { sessionId: c.agentSessionId }),
      ...(c.model ? { model: c.model } : {}),
      ...(c.permissionMode ? { permissionMode: c.permissionMode as never } : {}),
      ...(c.claudePath ? { pathToClaudeCodeExecutable: c.claudePath } : {}),
      ...(c.settingsPath ? { settings: c.settingsPath } : {}),
      // Without the preset the SDK uses a minimal system prompt, not Claude Code's.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Adaptive thinking as usual, but with its summary text kept, so thinking can be read in the rich view
      // and the Thinking tab (the SDK's default omits it).
      thinking: { type: 'adaptive', display: 'summarized' },
      env: { ...process.env },
      stderr: (d: string) => log('[claude]', d.trimEnd()),
      canUseTool: (tool, input, opts) => new Promise<PermissionResult>((resolve) => {
        const requestId = randomUUID();
        pending.set(requestId, { input, resolve });
        if (tool === 'AskUserQuestion') {
          push({ kind: 'question_request', requestId, questions: ((input as { questions?: RichQuestion[] }).questions ?? []) });
        } else push({ kind: 'permission_request', requestId, tool, input, reason: opts.decisionReason ?? null });
        opts.signal.addEventListener('abort', () => {
          if (pending.has(requestId)) resolvePermission(requestId, 'deny', 'Cancelled');
        });
      }),
    },
  });
  // Commands, models and account are known as soon as the CLI starts, before the first prompt.
  void q.initializationResult().then((r) => {
    info.commands = r.commands.map((x) => ({ name: x.name, description: x.description, argumentHint: x.argumentHint ?? '' }));
    info.models = r.models.map((x) => ({ value: x.value, displayName: x.displayName, description: x.description }));
    // Present at runtime (2.1.306) but not in the SDK's declared type.
    const extra = r as { available_output_styles?: string[]; current_permission_mode?: string };
    info.outputStyles = extra.available_output_styles ?? [];
    info.version = r.claude_code_version ?? info.version;
    info.permissionMode = info.permissionMode ?? extra.current_permission_mode ?? null;
    info.account = {
      email: r.account?.email ?? null, organization: r.account?.organization ?? null,
      subscription: r.account?.subscriptionType ?? null, authSource: info.account?.authSource ?? r.account?.apiKeySource ?? null,
    };
  }).catch((e) => log('initializationResult failed', e));
  try {
    for await (const m of q) onSdkMessage(m);
    await shutdown('the agent exited');
  } catch (e) {
    const message = (e as Error).message;
    log('query failed', message);
    push({ kind: 'error', message });
    await shutdown(`the agent failed: ${message}`, 1);
  }
}

process.on('SIGTERM', () => void shutdown('stopped'));
process.on('SIGINT', () => void shutdown('stopped'));
process.on('SIGHUP', () => { /* keep running when the parent's terminal goes away */ });
main().catch((e) => {
  log('host failed', e);
  void shutdown(`host failed: ${(e as Error).message}`, 1);
});
