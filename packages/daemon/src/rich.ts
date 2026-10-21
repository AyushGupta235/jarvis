import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { RichEnvelope } from '@jarvis/protocol';
import { richSocketPath, type RichHostConfig, type RichHostMeta } from '@jarvis/protocol/node';
import { log, logError } from './log';

interface Conn {
  sock: Socket;
  pid: number;
  events: RichEnvelope[];
  seq: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
}

export interface RichStartOptions {
  id: string;
  cwd: string;
  agentSessionId: string;
  resume: boolean;
  model: string | null;
  permissionMode: string | null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rich sessions, as seen from jarvisd: one jarvis-agent-host process per session, which this spawns
 * detached and talks to over its socket. Hosts outlive jarvisd; on start it reconnects to the ones
 * still running. Emits 'event' (id, envelope) and 'changed' (id) when a host connects or goes away.
 */
export class RichSessions extends EventEmitter {
  private conns = new Map<string, Conn>();
  private readonly dir: string;

  constructor(
    private readonly home: string,
    private readonly hostScript: string,
    /** Environment for hosts: your login shell's, so Bash tool calls and hooks see the same PATH as a terminal. */
    private readonly hostEnv: () => Promise<NodeJS.ProcessEnv>,
    private readonly extra: { claudePath: () => string | null; settingsPath: string | null; daemonSocket: string },
  ) {
    super();
    this.dir = join(home, 'rich');
    mkdirSync(this.dir, { recursive: true });
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  connected(id: string): boolean {
    return this.conns.has(id);
  }

  hostPid(id: string): number | null {
    return this.conns.get(id)?.pid ?? this.meta(id)?.pid ?? null;
  }

  history(id: string): RichEnvelope[] {
    return this.conns.get(id)?.events ?? [];
  }

  private meta(id: string): RichHostMeta | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(id), 'utf8')) as RichHostMeta;
    } catch {
      return null;
    }
  }

  /** Reconnect to hosts that kept running while jarvisd was down. */
  async restore(ids: string[]): Promise<void> {
    const known = new Set(ids);
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      const m = this.meta(id);
      if (!m || !alive(m.pid) || !known.has(id)) {
        if (m && alive(m.pid) && !known.has(id)) log(`rich host ${m.pid} belongs to no session (${id}); leaving it`);
        else try { unlinkSync(this.metaPath(id)); } catch { /* gone */ }
        continue;
      }
      await this.connect(id, m.socketPath, 3000).catch((e) => logError(`rich ${id}: reconnect failed`, (e as Error).message));
    }
  }

  async start(o: RichStartOptions): Promise<void> {
    if (this.conns.has(o.id)) return;
    const existing = this.meta(o.id);
    if (existing && alive(existing.pid)) {
      await this.connect(o.id, existing.socketPath, 3000);
      return;
    }
    const socketPath = richSocketPath(o.id);
    const claude = this.extra.claudePath();
    const cfg: RichHostConfig = {
      id: o.id, socketPath, metaPath: this.metaPath(o.id), cwd: o.cwd, agentSessionId: o.agentSessionId,
      resume: o.resume, model: o.model, permissionMode: o.permissionMode,
      // ~/.local/bin/claude is a symlink to the current version; resolve it so the SDK sees the real binary.
      claudePath: claude ? realpathSync(claude) : null,
      settingsPath: this.extra.settingsPath,
    };
    const env: NodeJS.ProcessEnv = {
      ...(await this.hostEnv()),
      JARVIS_HOST_CONFIG: JSON.stringify(cfg),
      JARVIS_SESSION: o.id,
      JARVIS_SOCKET: this.extra.daemonSocket,
    };
    // When jarvisd itself runs inside Electron (the app started it), the host needs the same switch to run as Node.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    mkdirSync(join(this.home, 'logs'), { recursive: true });
    const out = openSync(join(this.home, 'logs', `rich-${o.id}.log`), 'a');
    const child = spawn(process.execPath, [this.hostScript], { cwd: o.cwd, env, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    log(`rich ${o.id}: started host ${child.pid} (${o.resume ? 'resume' : 'new'} ${o.agentSessionId})`);
    await this.connect(o.id, socketPath, 20_000);
  }

  /** Connect, retrying until the host's socket is up or the deadline passes. */
  private async connect(id: string, socketPath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      try {
        await this.attach(id, socketPath);
        return;
      } catch (e) {
        lastErr = e as Error;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error(`rich host for ${id} did not come up: ${lastErr?.message ?? 'timeout'}`);
  }

  private attach(id: string, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!existsSync(socketPath)) return reject(new Error('no socket yet'));
      const sock = connect(socketPath);
      let buf = '';
      let ready = false;
      const conn: Conn = { sock, pid: 0, events: [], seq: 0, pending: new Map() };
      sock.once('error', (e) => { if (!ready) reject(e); });
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let m: any;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.op === 'hello') {
            conn.pid = m.pid;
            sock.write(`${JSON.stringify({ op: 'sub', since: 0 })}\n`);
          } else if (m.op === 'events') {
            conn.events = m.list;
            conn.seq = m.list.at(-1)?.seq ?? 0;
            if (!ready) {
              ready = true;
              this.conns.set(id, conn);
              log(`rich ${id}: connected to host ${conn.pid} (${conn.events.length} events)`);
              this.emit('changed', id);
              resolve();
            }
          } else if (m.op === 'reply') {
            const p = conn.pending.get(m.reqId);
            if (p) {
              conn.pending.delete(m.reqId);
              if (m.error) p.reject(new Error(m.error));
              else p.resolve(m.result);
            }
          } else if (m.op === 'ev') {
            const env = m.env as RichEnvelope;
            if (env.seq <= conn.seq) continue;
            conn.seq = env.seq;
            conn.events.push(env);
            if (conn.events.length > 20_000) conn.events.splice(0, conn.events.length - 20_000);
            this.emit('event', id, env);
          }
        }
      });
      sock.on('close', () => {
        for (const p of conn.pending.values()) p.reject(new Error('the session host went away'));
        conn.pending.clear();
        if (this.conns.get(id) === conn) {
          this.conns.delete(id);
          log(`rich ${id}: host ${conn.pid} disconnected`);
          this.emit('changed', id);
        }
        if (!ready) reject(new Error('closed before hello'));
      });
    });
  }

  private op(id: string, msg: Record<string, unknown>): void {
    const c = this.conns.get(id);
    if (!c) throw new Error('this rich session is not running; revive it first');
    c.sock.write(`${JSON.stringify(msg)}\n`);
  }

  private reqSeq = 0;

  /** Ask the host something and wait for its reply. */
  request<T>(id: string, op: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const c = this.conns.get(id);
    if (!c) return Promise.reject(new Error('this rich session is not running; revive it first'));
    const reqId = ++this.reqSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(reqId);
        reject(new Error(`the session host did not answer ${op}`));
      }, timeoutMs);
      c.pending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      c.sock.write(`${JSON.stringify({ ...params, op, reqId })}\n`);
    });
  }

  send(id: string, text: string): void {
    this.op(id, { op: 'send', text });
  }

  interrupt(id: string): void {
    this.op(id, { op: 'interrupt' });
  }

  respond(id: string, requestId: string, behavior: 'allow' | 'deny', message?: string): void {
    this.op(id, { op: 'respond', requestId, behavior, message });
  }

  answer(id: string, requestId: string, answers: Record<string, string | string[]>): void {
    this.op(id, { op: 'answer', requestId, answers });
  }

  /** Stop the host (the conversation stays in the transcript and can be revived). */
  async stop(id: string): Promise<void> {
    const pid = this.conns.get(id)?.pid ?? this.meta(id)?.pid ?? null;
    if (this.conns.has(id)) {
      this.op(id, { op: 'close' });
      const end = Date.now() + 3000;
      while (this.conns.has(id) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    }
    const m = this.meta(id);
    if (m && alive(m.pid)) {
      try { process.kill(m.pid, 'SIGTERM'); } catch { /* gone */ }
    }
    // Wait for it to exit, so nothing else writes this conversation while it is still closing.
    const end = Date.now() + 4000;
    while (pid && alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }

  /** Disconnect without stopping hosts (jarvisd is shutting down; hosts keep running). */
  detachAll(): void {
    for (const c of this.conns.values()) c.sock.destroy();
    this.conns.clear();
  }
}
