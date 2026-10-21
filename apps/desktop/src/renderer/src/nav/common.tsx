import { useEffect, useRef, useState } from 'react';
import type { FileEntry } from '@jarvis/protocol';
import { rpc } from '../store';

/** Re-run `load` when the repo's files change on disk (debounced), and on mount. */
export function useRepoData<T>(root: string | null, load: (root: string) => Promise<T>, onlyGitIndex = false): [T | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = () => {
    if (root) void loadRef.current(root).then(setData).catch(() => {});
  };
  useEffect(() => {
    setData(null);
    if (!root) return;
    reload();
    void rpc('files.watch', { root });
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = window.jarvis.onFilesChanged((c) => {
      if (c.root !== root) return;
      if (onlyGitIndex && !c.paths.some((p) => p === '.git/index' || !p.startsWith('.git'))) return;
      if (t) clearTimeout(t);
      t = setTimeout(reload, 400);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  return [data, reload];
}

const fileCache = new Map<string, { at: number; files: FileEntry[] }>();

export async function repoFiles(root: string, fresh = false): Promise<FileEntry[]> {
  const hit = fileCache.get(root);
  if (hit && !fresh && Date.now() - hit.at < 15_000) return hit.files;
  const r = await rpc<{ files: FileEntry[] }>('files.list', { root });
  fileCache.set(root, { at: Date.now(), files: r.files });
  return r.files;
}

export function statusClass(st: string | null): string {
  if (!st) return '';
  if (st === '??') return 'st-new';
  if (st.includes('D')) return 'st-del';
  if (st.includes('A')) return 'st-add';
  if (st.includes('U')) return 'st-conflict';
  return 'st-mod';
}

export function statusLetter(st: string | null): string {
  if (!st) return '';
  if (st === '??') return 'U';
  return st.trim().charAt(0) || st.charAt(1);
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="nav-empty">{children}</div>;
}
