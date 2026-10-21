import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((res) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 4000 }, (err, stdout) => res(err ? null : stdout.trim()));
  });
}

export interface RepoLocation {
  /** Main repo root (worktrees resolve to the repo they belong to). Non-git dirs: the dir itself. */
  repoRoot: string;
  /** Linked worktree root, if any. */
  worktree: string | null;
  toplevel: string | null;
}

export async function locate(dir: string): Promise<RepoLocation> {
  const out = await git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (!out) return { repoRoot: dir, worktree: null, toplevel: null };
  const [toplevel, commonRaw] = out.split('\n');
  if (!toplevel || !commonRaw) return { repoRoot: dir, worktree: null, toplevel: null };
  const common = isAbsolute(commonRaw) ? commonRaw : resolve(dir, commonRaw);
  const mainRoot = basename(common) === '.git' ? dirname(common) : toplevel;
  return { repoRoot: mainRoot, worktree: mainRoot === toplevel ? null : toplevel, toplevel };
}

/** Cached `git branch --show-current` per directory. */
export class BranchCache {
  private cache = new Map<string, { at: number; branch: string | null; pending?: Promise<void> }>();
  constructor(private ttlMs = 5000) {}

  get(dir: string | null): string | null {
    if (!dir) return null;
    const now = Date.now();
    const hit = this.cache.get(dir);
    if (!hit || (now - hit.at > this.ttlMs && !hit.pending)) {
      const entry = hit ?? { at: 0, branch: null };
      // `branch --show-current` also works on a fresh repo with no commits; empty output means detached HEAD.
      entry.pending = git(dir, ['branch', '--show-current']).then(async (b) => {
        if (b) entry.branch = b;
        else entry.branch = (await git(dir, ['rev-parse', '--git-dir'])) ? 'detached' : null;
        entry.at = Date.now();
        entry.pending = undefined;
      });
      this.cache.set(dir, entry);
    }
    return this.cache.get(dir)?.branch ?? null;
  }
}

export interface Worktree {
  path: string;
  branch: string | null;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const res: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) res.push(cur);
      cur = { path: line.slice(9), branch: null };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached' && cur) {
      cur.branch = 'detached';
    }
  }
  if (cur) res.push(cur);
  return res.filter((w) => existsSync(w.path));
}

/** Directories directly under `root` that are git repos (a .git dir or file). */
export function scanRepos(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((n) => !n.startsWith('.'))
      .map((n) => join(root, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory() && existsSync(join(p, '.git'));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
