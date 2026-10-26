import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface DirEntry {
  path: string;
  /** A git repository (has .git). */
  git: boolean;
}

/** Folders that are never what you mean to open a session in (and in your home folder, hold nothing of yours). */
const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Movies', 'Music', 'Pictures', 'Public', '__pycache__', 'venv']);

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The folders directly under `root`, git or not (a new folder you just made counts), and with `nested`, the git
 * repos one level further down inside a folder that is not itself a repo (~/code/work/api). Home is scanned
 * without `nested`: looking inside Documents and friends can mean reading tens of thousands of entries.
 */
export function scanDirs(root: string, nested: boolean): DirEntry[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: DirEntry[] = [];
  for (const n of names) {
    if (n.startsWith('.') || SKIP.has(n)) continue;
    const p = join(root, n);
    if (!isDir(p)) continue;
    if (existsSync(join(p, '.git'))) {
      out.push({ path: p, git: true });
      continue;
    }
    out.push({ path: p, git: false });
    if (!nested) continue;
    try {
      for (const m of readdirSync(p)) {
        if (m.startsWith('.') || SKIP.has(m)) continue;
        const q = join(p, m);
        if (isDir(q) && existsSync(join(q, '.git'))) out.push({ path: q, git: true });
      }
    } catch { /* unreadable */ }
  }
  return out;
}

/**
 * Directories to complete a path you are typing: `~/Doc` lists the folders in ~ that start with "Doc", `/Users/me/`
 * lists everything inside it. Hidden folders appear only when you type the dot.
 */
export function completeDirs(prefix: string, limit = 80): { dir: string; exists: boolean; entries: DirEntry[] } {
  const expanded = prefix.replace(/^~(?=$|\/)/, homedir());
  const endsInSlash = expanded.endsWith('/');
  const abs = resolve(expanded);
  const parent = endsInSlash || expanded === '' ? abs : dirname(abs);
  const stem = endsInSlash ? '' : basename(abs).toLowerCase();
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch { /* not a directory */ }
  const entries = names
    .filter((n) => n.toLowerCase().startsWith(stem) && (!n.startsWith('.') || stem.startsWith('.')) && !SKIP.has(n))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => join(parent, n))
    .filter(isDir)
    .slice(0, limit)
    .map((p) => ({ path: p, git: existsSync(join(p, '.git')) }));
  return { dir: abs, exists: isDir(abs), entries };
}
