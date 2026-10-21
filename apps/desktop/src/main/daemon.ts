import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import WebSocket from 'ws';
import type { RpcResponse, ServerEvent, Snapshot } from '@jarvis/protocol';
import { daemonSocketPath, jarvisHome } from '@jarvis/protocol/node';

const LABEL = 'dev.jarvis.jarvisd';

/** Connects to jarvisd over its unix socket, starting the daemon if needed, and reconnects forever. */
export class DaemonClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private closed = false;
  private startAttempted = 0;
  snapshot: Snapshot | null = null;
  connected = false;
  readonly socketPath = daemonSocketPath();

  constructor(private readonly daemonBundle: string) {
    super();
  }

  start(): void {
    void this.connect();
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private health(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!existsSync(this.socketPath)) return resolve(false);
      const req = request({ socketPath: this.socketPath, path: '/health', timeout: 1000 }, (r) => {
        r.resume();
        resolve(r.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  /** Start jarvisd: via launchd if the agent is installed, else as a detached child using Electron's Node. */
  private launchDaemon(): void {
    const uid = userInfo().uid;
    // The launchd agent serves the default home only; custom JARVIS_HOME (tests) always gets its own daemon.
    if (!process.env.JARVIS_HOME && spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }).status === 0) {
      spawnSync('launchctl', ['kickstart', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
      return;
    }
    if (!existsSync(this.daemonBundle)) {
      this.emit('status', { connected: false, error: `daemon bundle missing: ${this.daemonBundle}` });
      return;
    }
    const logs = join(jarvisHome(), 'logs');
    mkdirSync(logs, { recursive: true });
    const out = openSync(join(logs, 'jarvisd.log'), 'a');
    spawn(process.execPath, ['--disable-warning=ExperimentalWarning', this.daemonBundle], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).unref();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    if (!(await this.health())) {
      if (Date.now() - this.startAttempted > 5000) {
        this.startAttempted = Date.now();
        this.launchDaemon();
      }
      setTimeout(() => void this.connect(), 300);
      return;
    }
    const ws = new WebSocket(`ws+unix://${this.socketPath}:/ws`);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.emit('status', { connected: true });
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerEvent | RpcResponse;
      if ('event' in msg) {
        if (msg.event === 'snapshot') {
          this.snapshot = msg.data;
          this.emit('snapshot', msg.data);
        } else {
          this.emit(msg.event, msg.data);
        }
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    });
    const onDown = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connected) {
        this.connected = false;
        this.emit('status', { connected: false, error: 'jarvisd disconnected, reconnecting' });
      }
      for (const p of this.pending.values()) p.rej(new Error('jarvisd disconnected'));
      this.pending.clear();
      setTimeout(() => void this.connect(), 500);
    };
    ws.on('close', onDown);
    ws.on('error', onDown);
  }

  rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('jarvisd not connected'));
    const id = this.nextId++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
