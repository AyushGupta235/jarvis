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
import { getSessionMessages, listSessions, query, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { RichConversation, RichEnvelope, RichEvent, RichInfo } from '@jarvis/protocol';
import type { RichHostConfig, RichHostMeta } from '@jarvis/protocol/node';

const cfg = JSON.parse(process.env.JARVIS_HOST_CONFIG ?? 'null') as RichHostConfig | null;
if (!cfg) {
  console.error('JARVIS_HOST_CONFIG is not set');
  process.exit(2);
}
delete process.env.JARVIS_HOST_CONFIG;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

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
  if (role === 'user') {
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

function onSdkMessage(m: SDKMessage): void {
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
      } else if (m.subtype === 'compact_boundary') push({ kind: 'compact' });
      return;
    case 'assistant':
      fromMessage('assistant', m.message, m.parent_tool_use_id, false);
      return;
    case 'user':
      fromMessage('user', m.message, m.parent_tool_use_id, false);
      return;
    case 'result':
      push({
        kind: 'turn_end', ok: m.subtype === 'success', durationMs: m.duration_ms ?? null, costUsd: m.total_cost_usd ?? null,
        error: m.subtype === 'success' ? null : ('errors' in m && m.errors?.length ? m.errors.join('; ') : m.subtype),
      });
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

  push(text: string): void {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
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
    send(c, { op: 'hello', pid: process.pid, agentSessionId: cfg!.agentSessionId, seq });
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
      push({ kind: 'user', text });
      inbox.push(text);
      return;
    }
    case 'interrupt':
      void q?.interrupt().catch((e) => log('interrupt failed', e));
      return;
    case 'respond':
      resolvePermission(String(msg.requestId), msg.behavior === 'allow' ? 'allow' : 'deny', msg.message);
      return;
    case 'close':
      void shutdown('closed from Jarvis');
      return;
    case 'info':
    case 'conversations':
    case 'set_mode':
      void request(msg.op, msg)
        .then((result) => send(c, { op: 'reply', reqId: msg.reqId, result }))
        .catch((e) => send(c, { op: 'reply', reqId: msg.reqId, error: (e as Error).message }));
      return;
    default:
      return;
  }
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
    // The conversation so far, from Claude's transcript, so a revived session shows its history.
    const msgs = await getSessionMessages(c.agentSessionId, { dir: c.cwd }).catch((e) => {
      log('could not read history', e);
      return [];
    });
    for (const m of msgs) if (m.type === 'user' || m.type === 'assistant') fromMessage(m.type, m.message, m.parent_tool_use_id, true);
    push({ kind: 'resumed', messages: msgs.length });
  }
  await serve();
  writeMeta();
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
        push({ kind: 'permission_request', requestId, tool, input, reason: opts.decisionReason ?? null });
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
