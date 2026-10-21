import * as pty from 'node-pty';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WebContents } from 'electron';
import type { AttachSpec } from '@jarvis/protocol';

const STRIP = /^(TMUX|TMUX_PANE|CLAUDECODE|CLAUDE_.*|ELECTRON_.*|NODE_OPTIONS)$/;

function clientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) env[k] = v;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Jarvis';
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_CTYPE = env.LC_CTYPE || 'en_US.UTF-8';
  return env;
}

/** node-pty 1.1 prebuilds lack the exec bit on spawn-helper; repair it once at startup. */
export function ensureSpawnHelper(): void {
  try {
    const root = dirname(require.resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked');
    for (const rel of [`prebuilds/darwin-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
      const p = join(root, rel);
      if (existsSync(p) && (statSync(p).mode & 0o111) === 0) chmodSync(p, 0o755);
    }
  } catch { /* best effort; spawn errors surface to the UI */ }
}

interface Entry {
  proc: pty.IPty;
  buf: string;
  timer: NodeJS.Timeout | null;
  owner: WebContents;
}

/**
 * One PTY per mounted terminal view. Each PTY runs a `tmux attach` client, so closing it only
 * detaches; the session and its agent keep running in the tmux server.
 */
export class PtyManager {
  private ptys = new Map<number, Entry>();
  private nextId = 1;

  open(owner: WebContents, spec: AttachSpec, cols: number, rows: number): number {
    const id = this.nextId++;
    const proc = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
      cwd: homedir(),
      env: clientEnv(),
    });
    const entry: Entry = { proc, buf: '', timer: null, owner };
    this.ptys.set(id, entry);
    // Coalesce bursts of output into ~4ms frames to keep IPC traffic low under heavy agent output.
    proc.onData((d) => {
      entry.buf += d;
      if (!entry.timer) {
        entry.timer = setTimeout(() => {
          entry.timer = null;
          const data = entry.buf;
          entry.buf = '';
          if (!owner.isDestroyed()) owner.send('pty:data', id, data);
        }, 4);
      }
    });
    proc.onExit(({ exitCode }) => {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.buf && !owner.isDestroyed()) owner.send('pty:data', id, entry.buf);
      this.ptys.delete(id);
      if (!owner.isDestroyed()) owner.send('pty:exit', id, exitCode);
    });
    return id;
  }

  write(id: number, data: string): void {
    this.ptys.get(id)?.proc.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    const e = this.ptys.get(id);
    if (!e || cols < 2 || rows < 2) return;
    try {
      e.proc.resize(cols, rows);
    } catch { /* already exited */ }
  }

  close(id: number): void {
    const e = this.ptys.get(id);
    if (!e) return;
    this.ptys.delete(id);
    try {
      e.proc.kill();
    } catch { /* gone */ }
  }

  closeAllFor(owner: WebContents): void {
    for (const [id, e] of this.ptys) if (e.owner === owner) this.close(id);
  }

  closeAll(): void {
    for (const id of [...this.ptys.keys()]) this.close(id);
  }
}
