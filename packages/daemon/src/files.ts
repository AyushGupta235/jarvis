import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ChangedFile, FileContent, FileEntry } from '@jarvis/protocol';

const MAX_FILES = 50_000;
const MAX_TEXT = 2 << 20;
const MAX_IMAGE = 10 << 20;
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.turbo', '.cache']);

function git(cwd: string, args: string[], okCodes = [0]): Promise<string | null> {
  return new Promise((res) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 64 << 20, timeout: 15_000 }, (err, stdout) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      res(okCodes.includes(code) ? stdout : null);
    });
  });
}

export async function listFiles(root: string): Promise<{ files: FileEntry[]; truncated: boolean }> {
  const out = await git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  let paths: string[];
  if (out !== null) paths = out.split('\0').filter(Boolean);
  else {
    paths = [];
    const walk = (dir: string) => {
      if (paths.length >= MAX_FILES) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.claude' && e.name !== '.github') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(p);
        } else paths.push(relative(root, p));
        if (paths.length >= MAX_FILES) return;
      }
    };
    walk(root);
  }
  const status = await statusMap(root);
  const truncated = paths.length > MAX_FILES;
  return { files: paths.slice(0, MAX_FILES).map((p) => ({ path: p, status: status.get(p) ?? null })), truncated };
}

async function statusMap(root: string): Promise<Map<string, string>> {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '-uall']);
  const m = new Map<string, string>();
  if (!out) return m;
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    const xy = e.slice(0, 2);
    m.set(e.slice(3), xy);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // rename source follows
  }
  return m;
}

export async function changes(root: string): Promise<ChangedFile[]> {
  const status = await statusMap(root);
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])) !== null;
  const num = new Map<string, [number | null, number | null]>();
  const ns = hasHead ? await git(root, ['diff', '--numstat', 'HEAD']) : await git(root, ['diff', '--numstat', '--cached']);
  for (const l of (ns ?? '').split('\n')) {
    const [a, r, ...p] = l.split('\t');
    if (!p.length) continue;
    num.set(p.join('\t'), [a === '-' ? null : Number(a), r === '-' ? null : Number(r)]);
  }
  const out: ChangedFile[] = [];
  for (const [path, st] of status) {
    let [added, removed] = num.get(path) ?? [null, null];
    if (st === '??' && added === null) {
      try {
        const s = statSync(join(root, path));
        if (s.size < MAX_TEXT) {
          added = readFileSync(join(root, path), 'utf8').split('\n').length;
          removed = 0;
        }
      } catch { /* gone */ }
    }
    out.push({ path, status: st, added, removed });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function diff(root: string, path: string): Promise<string> {
  const status = (await statusMap(root)).get(path);
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])) !== null;
  if (status === '??' || !hasHead) {
    return (await git(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', path], [0, 1])) ?? '';
  }
  return (await git(root, ['diff', '--no-color', 'HEAD', '--', path])) ?? '';
}

/**
 * Where a file the agent named actually is. An absolute or ~ path is itself; a relative one is looked for under each
 * base in turn (the agent's folder, its repo, their parents), because the agent says "apps/web/.env" from wherever it
 * stands, not from where the session started. Only files count (a folder cannot be opened in the viewer).
 */
export function resolveRefs(refs: string[], bases: string[], home: string): (string | null)[] {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  return refs.map((raw) => {
    const ref = raw.replace(/^~(?=$|\/)/, home);
    if (isAbsolute(ref)) return isFile(ref) ? resolve(ref) : null;
    for (const b of bases) {
      const p = resolve(b, ref);
      if (isFile(p)) return p;
    }
    return null;
  });
}

export type WriteResult = { ok: true; mtime: number; size: number } | { ok: false; reason: 'conflict' | 'error'; message: string };

/**
 * Save an edit. `expectedMtime` is the modification time the editor loaded: if the file has changed since, nothing is
 * written (`conflict`) so an edit made elsewhere is not lost; null skips the check (Overwrite) or, with `create`,
 * makes a new file. Writes in place, so permissions (a 0600 .env) are kept.
 */
export function writeText(path: string, text: string, expectedMtime: number | null, create = false): WriteResult {
  if (!isAbsolute(path)) return { ok: false, reason: 'error', message: 'Not an absolute path.' };
  if (Buffer.byteLength(text) > MAX_TEXT) return { ok: false, reason: 'error', message: 'Too large to save from here.' };
  let st;
  try {
    st = statSync(path);
  } catch {
    st = null;
  }
  try {
    if (st) {
      if (!st.isFile()) return { ok: false, reason: 'error', message: 'Not a file.' };
      if (expectedMtime != null && Math.abs(st.mtimeMs - expectedMtime) > 1) {
        return { ok: false, reason: 'conflict', message: 'This file changed on disk since you opened it.' };
      }
    } else if (!create) {
      return { ok: false, reason: 'error', message: 'The file no longer exists.' };
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, text);
    const now = statSync(path);
    return { ok: true, mtime: now.mtimeMs, size: now.size };
  } catch (e) {
    return { ok: false, reason: 'error', message: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'No permission to write this file.' : String((e as Error).message) };
  }
}

export function readFile(path: string): FileContent {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { path, kind: 'missing', size: 0, mtime: 0 };
  }
  const base = { path, size: st.size, mtime: st.mtimeMs };
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (mime) {
    if (st.size > MAX_IMAGE) return { ...base, kind: 'too-large' };
    return { ...base, kind: 'image', dataUrl: `data:${mime};base64,${readFileSync(path).toString('base64')}` };
  }
  if (st.size > MAX_TEXT) return { ...base, kind: 'too-large' };
  const buf = readFileSync(path);
  if (buf.subarray(0, 8192).includes(0)) return { ...base, kind: 'binary' };
  return { ...base, kind: 'text', text: buf.toString('utf8') };
}

/** Recursive FSEvents watchers for the repos a client is looking at, with debounced change events. */
export class FileWatcher extends EventEmitter {
  private watchers = new Map<string, { w: FSWatcher; used: number; pending: Set<string>; timer: NodeJS.Timeout | null }>();

  watch(root: string): void {
    const hit = this.watchers.get(root);
    if (hit) {
      hit.used = Date.now();
      return;
    }
    if (!existsSync(root)) return;
    if (this.watchers.size >= 8) {
      const oldest = [...this.watchers.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest) {
        oldest[1].w.close();
        this.watchers.delete(oldest[0]);
      }
    }
    try {
      const entry = { w: null as unknown as FSWatcher, used: Date.now(), pending: new Set<string>(), timer: null as NodeJS.Timeout | null };
      entry.w = watch(root, { recursive: true }, (_ev, file) => {
        const f = String(file ?? '');
        if (f.includes('node_modules/')) return;
        if (f.startsWith('.git/') && f !== '.git/index' && f !== '.git/HEAD') return;
        entry.pending.add(f);
        if (!entry.timer) {
          entry.timer = setTimeout(() => {
            entry.timer = null;
            const paths = [...entry.pending];
            entry.pending.clear();
            this.emit('changed', { root, paths });
          }, 200);
        }
      });
      entry.w.on('error', () => {
        entry.w.close();
        this.watchers.delete(root);
      });
      this.watchers.set(root, entry);
    } catch { /* unwatchable */ }
  }

  close(): void {
    for (const e of this.watchers.values()) e.w.close();
    this.watchers.clear();
  }
}
