import { useEffect, useMemo, useState } from 'react';
import type { ChangedFile, DocEntry, FileEntry, SessionInfo } from '@jarvis/protocol';
import { fuzzyFilter } from '../fuzzy';
import { openInViewer, rpc, sessionRoot, useStore } from '../store';
import { Empty, repoFiles, statusClass, statusLetter, useRepoData } from './common';

type Mode = 'all' | 'changed' | 'touched';

interface Dir { name: string; path: string; dirs: Map<string, Dir>; files: FileEntry[] }

function buildTree(files: FileEntry[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = d.dirs.get(name);
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] };
        d.dirs.set(name, next);
      }
      d = next;
    }
    d.files.push(f);
  }
  return root;
}

function dirStatus(d: Dir): boolean {
  return d.files.some((f) => f.status) || [...d.dirs.values()].some(dirStatus);
}

export function FilesTab({ s }: { s: SessionInfo }) {
  const root = sessionRoot(s);
  const [files] = useRepoData(root, (r) => repoFiles(r, true));
  const [touched, setTouched] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('all');
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const activePath = useStore((st) => st.viewerTabs[st.viewerActive]?.path);

  useEffect(() => {
    if (!s.external) void rpc<string[]>('files.touched', { id: s.id }).then(setTouched).catch(() => {});
  }, [s.id, s.external, files]);

  const touchedRel = useMemo(() => new Set(touched.filter((p) => root && p.startsWith(root + '/')).map((p) => p.slice(root!.length + 1))), [touched, root]);
  const visible = useMemo(() => {
    let list = files ?? [];
    if (mode === 'changed') list = list.filter((f) => f.status);
    if (mode === 'touched') list = list.filter((f) => touchedRel.has(f.path));
    return list;
  }, [files, mode, touchedRel]);
  const tree = useMemo(() => buildTree(visible), [visible]);
  const results = useMemo(() => (query.trim() ? fuzzyFilter(visible, query, (f) => f.path).slice(0, 200) : null), [visible, query]);

  if (!root) return <Empty>No directory for this session.</Empty>;
  const open = (f: FileEntry) => openInViewer({ path: `${root}/${f.path}`, root, mode: 'file' });
  const toggle = (p: string) => setOpenDirs((o) => {
    const n = new Set(o);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });
  const forceOpen = mode !== 'all';

  const renderDir = (d: Dir, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of dirs) {
      const isOpen = forceOpen || openDirs.has(sub.path);
      out.push(
        <div key={`d:${sub.path}`} className="tree-row dir" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(sub.path)}>
          <span className={`chev ${isOpen ? '' : 'closed'}`}>▾</span>
          <span className={`tree-name ${dirStatus(sub) ? 'has-changes' : ''}`}>{sub.name}</span>
        </div>,
      );
      if (isOpen) out.push(...renderDir(sub, depth + 1));
    }
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const name = f.path.split('/').pop();
      const full = `${root}/${f.path}`;
      out.push(
        <div key={`f:${f.path}`} className={`tree-row file ${full === activePath ? 'active' : ''}`} style={{ paddingLeft: 20 + depth * 12 }} onClick={() => open(f)}>
          <span className={`tree-name ${statusClass(f.status)}`}>{name}</span>
          {touchedRel.has(f.path) && <span className="touched" title="Edited by the agent this session">✳</span>}
          {f.status && <span className={`st ${statusClass(f.status)}`}>{statusLetter(f.status)}</span>}
        </div>,
      );
    }
    return out;
  };

  return (
    <div className="nav-col">
      <div className="nav-search">
        <input placeholder={`Filter ${files ? files.length.toLocaleString() : ''} files…`} value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results?.[0]) open(results[0]);
            if (e.key === 'Escape') setQuery('');
          }} />
      </div>
      <div className="nav-filters">
        {(['all', 'changed', 'touched'] as Mode[]).map((m) => (
          <button key={m} className={`filter ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>
            {m === 'touched' ? `agent edited ${touchedRel.size || ''}` : m === 'changed' ? `changed ${(files ?? []).filter((f) => f.status).length || ''}` : 'all'}
          </button>
        ))}
      </div>
      <div className="nav-scroll tree">
        {!files && <Empty>Loading…</Empty>}
        {results
          ? results.map((f) => (
            <div key={f.path} className="tree-row file flat" onClick={() => open(f)}>
              <span className={`tree-name ${statusClass(f.status)}`}>{f.path.split('/').pop()}</span>
              <span className="tree-dir">{f.path.split('/').slice(0, -1).join('/')}</span>
            </div>
          ))
          : renderDir(tree, 0)}
        {files && !visible.length && <Empty>{mode === 'changed' ? 'Working tree is clean.' : mode === 'touched' ? 'The agent has not edited files in this repo yet.' : 'No files.'}</Empty>}
      </div>
    </div>
  );
}

export function ChangesTab({ s }: { s: SessionInfo }) {
  const root = sessionRoot(s);
  const [changes, reload] = useRepoData<ChangedFile[]>(root, (r) => rpc('files.changes', { root: r }), true);
  if (!root) return <Empty>No directory for this session.</Empty>;
  const added = (changes ?? []).reduce((a, c) => a + (c.added ?? 0), 0);
  const removed = (changes ?? []).reduce((a, c) => a + (c.removed ?? 0), 0);
  return (
    <div className="nav-col">
      <div className="nav-head">
        <span>{changes ? `${changes.length} changed file${changes.length === 1 ? '' : 's'}` : 'Loading…'}</span>
        <span className="plus">+{added}</span><span className="minus">−{removed}</span>
        <span className="strip-spacer" />
        <span className="muted">{s.branch}</span>
        <button className="icon-btn" title="Refresh" onClick={reload}>↻</button>
      </div>
      <div className="nav-scroll">
        {changes && !changes.length && <Empty>Working tree is clean.</Empty>}
        {(changes ?? []).map((c) => (
          <div key={c.path} className="change-row" onClick={() => openInViewer({ path: `${root}/${c.path}`, root, mode: 'diff' })}>
            <span className={`st ${statusClass(c.status)}`}>{statusLetter(c.status)}</span>
            <span className="change-name">{c.path.split('/').pop()}</span>
            <span className="tree-dir">{c.path.split('/').slice(0, -1).join('/')}</span>
            <span className="strip-spacer" />
            {c.added != null && <span className="plus">+{c.added}</span>}
            {c.removed != null && <span className="minus">−{c.removed}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DocsTab({ s }: { s: SessionInfo }) {
  const [docs, setDocs] = useState<DocEntry[] | null>(null);
  const root = sessionRoot(s);
  useEffect(() => {
    setDocs(null);
    if (!s.external) void rpc<DocEntry[]>('docs.list', { id: s.id }).then(setDocs).catch(() => setDocs([]));
  }, [s.id, s.external]);
  if (s.external) return <Empty>Docs are listed for Jarvis sessions.</Empty>;
  const groups = new Map<string, DocEntry[]>();
  for (const d of docs ?? []) groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
  return (
    <div className="nav-scroll">
      {!docs && <Empty>Loading…</Empty>}
      {docs && !docs.length && <Empty>No markdown docs found.</Empty>}
      {[...groups.entries()].map(([g, list]) => (
        <section key={g} className="doc-group">
          <div className="doc-group-title">{g}</div>
          {list.map((d) => (
            <div key={d.path} className="doc-row" title={d.path} onClick={() => openInViewer({ path: d.path, root, mode: 'file' })}>
              <span className="doc-icon">{g === 'Agent instructions' ? '✳' : g === 'Plans' ? '◇' : '¶'}</span>
              <span className="doc-label">{d.label}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
