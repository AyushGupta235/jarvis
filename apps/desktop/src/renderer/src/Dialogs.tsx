import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentDef, AgentKind, RepoCandidate, SessionInfo, SessionMode } from '@jarvis/protocol';
import { fuzzyFilter } from './fuzzy';
import { activeSession, activity, ago, focusTerminal, getState, openInViewer, rpc, sessionRoot, setState, tildify, useStore } from './store';
import { repoFiles, statusClass } from './nav/common';
import type { FileEntry } from '@jarvis/protocol';
import { activate } from './actions';

function close(): void {
  setState({ dialog: null });
  focusTerminal();
}

function Modal({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`modal ${wide ? 'wide' : ''}`} onKeyDown={(e) => e.key === 'Escape' && close()}>
        {children}
      </div>
    </div>
  );
}

function useListNav(len: number): [number, (i: number) => void, (e: React.KeyboardEvent) => boolean] {
  const [sel, setSel] = useState(0);
  useEffect(() => {
    if (sel >= len) setSel(Math.max(0, len - 1));
  }, [len, sel]);
  const onKey = (e: React.KeyboardEvent): boolean => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      setSel((i) => Math.min(len - 1, i + 1));
      return true;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      setSel((i) => Math.max(0, i - 1));
      return true;
    }
    return false;
  };
  return [sel, setSel, onKey];
}

function Segmented<T>({ options, value, onChange, label }: {
  options: { value: T; label: string; disabled?: boolean; title?: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  const enabled = options.filter((o) => !o.disabled);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const eidx = Math.max(0, enabled.findIndex((o) => o.value === value));
  return (
    <div className="seg" role="radiogroup" aria-label={label} tabIndex={0}
      onKeyDown={(e) => {
        if (!enabled.length) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); onChange(enabled[(eidx + 1) % enabled.length]!.value); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(enabled[(eidx - 1 + enabled.length) % enabled.length]!.value); }
      }}>
      <span className="seg-label">{label}</span>
      {options.map((o, i) => (
        <button key={String(o.value)} tabIndex={-1} disabled={o.disabled} title={o.title}
          className={`seg-btn ${i === idx ? 'on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NewSessionDialog({ repoPath }: { repoPath?: string }) {
  const lastAgent = useStore((s) => s.lastAgent);
  const lastModel = useStore((s) => s.lastModel);
  const agents = useStore((s) => s.snapshot?.agents);
  const [repos, setRepos] = useState<RepoCandidate[] | null>(null);
  const [query, setQuery] = useState('');
  const [agent, setAgentRaw] = useState<AgentKind>(lastAgent);
  const [model, setModel] = useState<string | null>(lastModel);
  const lastMode = useStore((s) => s.lastMode);
  const [mode, setMode] = useState<SessionMode>(lastMode);
  const def: AgentDef | undefined = agents?.find((a) => a.id === agent);
  const setAgent = (id: AgentKind) => {
    setAgentRaw(id);
    const next = agents?.find((a) => a.id === id);
    if (!next?.models?.some((m) => m.value === model)) setModel(null);
  };
  useEffect(() => {
    void rpc('agents.list');
  }, []);
  // Installed agents first, then the shell, then known-but-missing ones (disabled).
  const agentOptions = useMemo(() => {
    const list = agents ?? [];
    const rank = (a: AgentDef) => (a.id === 'shell' ? 1 : a.available === false ? 2 : 0);
    return [...list].sort((a, b) => rank(a) - rank(b)).map((a) => ({
      value: a.id,
      label: a.label.replace(/ Code$| CLI$/, ''),
      disabled: a.available === false,
      title: a.available === false ? `${a.command} not found on PATH` : a.path ?? undefined,
    }));
  }, [agents]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void rpc<RepoCandidate[]>('repos.list').then((list) => {
      // Preselect: the requested repo, else the active session's directory.
      const cur = activeSession(getState());
      const want = repoPath ?? cur?.worktree ?? cur?.repoRoot;
      const i = want ? list.findIndex((r) => r.path === want) : -1;
      if (i > 0) list.unshift(...list.splice(i, 1));
      setRepos(list);
    });
  }, [repoPath]);

  const filtered = useMemo(
    () => fuzzyFilter(repos ?? [], query, (r) => `${r.name} ${r.branch ?? ''} ${r.path}`).slice(0, 60),
    [repos, query],
  );
  const [sel, setSel, navKey] = useListNav(filtered.length);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.opt.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const create = async (path?: string) => {
    const target = path ?? filtered[sel]?.path;
    if (!target || busy) return;
    setBusy(true);
    try {
      const richOk = def?.integration === 'claude';
      const s = await rpc<SessionInfo>('sessions.create', {
        cwd: target, agent, model: def?.modelArgs ? model : null, name: name || null, mode: richOk ? mode : 'terminal',
      });
      setState({ lastAgent: agent, lastModel: model, ...(richOk ? { lastMode: mode } : {}) });
      activate(s.id);
    } catch {
      setBusy(false);
    }
  };

  const browse = async () => {
    const dir = await window.jarvis.chooseDirectory();
    if (dir) void create(dir);
  };

  return (
    <Modal wide>
      <div className="modal-title">New session</div>
      <input
        ref={input}
        className="modal-input"
        placeholder="Search repos and worktrees…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (navKey(e)) e.preventDefault();
          else if (e.key === 'Enter') { e.preventDefault(); void create(); }
        }}
      />
      <div className="opt-list" ref={listRef}>
        {repos === null && <div className="opt muted">Loading repos…</div>}
        {repos !== null && filtered.length === 0 && <div className="opt muted">No match. Use Browse to pick any folder.</div>}
        {filtered.map((r, i) => (
          <div key={r.path} className={`opt ${i === sel ? 'sel' : ''}`} onMouseMove={() => i !== sel && setSel(i)} onClick={() => void create(r.path)}>
            <span className="opt-name">{r.isWorktree && <span className="tag">worktree</span>}{r.name}</span>
            <span className="opt-branch">{r.branch}</span>
            <span className="opt-path">{tildify(r.path)}</span>
            <span className="opt-age">{r.lastUsed ? ago(r.lastUsed) : ''}</span>
          </div>
        ))}
      </div>
      <div className="modal-row">
        <Segmented label="Agent" options={agentOptions} value={agent} onChange={setAgent} />
      </div>
      <div className="modal-row">
        {def?.models ? (
          <Segmented label="Model" options={def.models} value={model} onChange={setModel} />
        ) : def?.modelArgs ? (
          <input className="modal-input small" placeholder={`Model for ${def.label} (optional, e.g. a local model id)`}
            value={model ?? ''} onChange={(e) => setModel(e.target.value || null)}
            onKeyDown={(e) => e.key === 'Enter' && void create()} />
        ) : null}
      </div>
      {def?.integration === 'claude' && (
        <div className="modal-row">
          <Segmented label="View" options={[{ value: 'terminal', label: 'Terminal' }, { value: 'rich', label: 'Rich (SDK)' }]}
            value={mode} onChange={(v) => setMode(v as SessionMode)} />
        </div>
      )}
      <div className="modal-row">
        <input className="modal-input small" placeholder="Name (optional)" value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()} />
        <button className="btn" onClick={() => void browse()}>Browse…</button>
        <button className="btn primary" disabled={busy || !filtered.length} onClick={() => void create()}>
          {busy ? 'Starting…' : 'Start'} <kbd>↵</kbd>
        </button>
      </div>
      <div className="modal-hint">↑↓ pick · ⇥ fields · ←→ change option · ↵ start · esc cancel</div>
    </Modal>
  );
}

export function QuickSwitcher() {
  const snapshot = useStore((s) => s.snapshot);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const now = Date.now();
  const all = useMemo(
    () => [...(snapshot?.sessions ?? [])].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)),
    [snapshot],
  );
  const wsName = (s: SessionInfo) => snapshot?.workspaces.find((w) => w.root === s.repoRoot)?.name ?? '';
  const filtered = fuzzyFilter(all, query, (s) => `${s.name} ${wsName(s)} ${s.branch ?? ''} ${s.model ?? ''}`).slice(0, 50);
  const [sel, setSel, navKey] = useListNav(filtered.length);

  return (
    <Modal>
      <input
        ref={input}
        className="modal-input"
        placeholder="Jump to session…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (navKey(e)) e.preventDefault();
          else if (e.key === 'Enter') { const t = filtered[sel]; if (t) activate(t.id); }
        }}
      />
      <div className="opt-list">
        {filtered.map((s, i) => (
          <div key={s.id} className={`opt ${i === sel ? 'sel' : ''}`} onMouseMove={() => i !== sel && setSel(i)} onClick={() => activate(s.id)}>
            <i className={`dot ${activity(s, now)}`} />
            <span className="opt-name">{s.name}</span>
            <span className="opt-branch">{wsName(s)}{s.branch ? ` · ${s.branch}` : ''}</span>
            <span className="opt-age">{ago(s.lastActivity, now)}</span>
          </div>
        ))}
        {!filtered.length && <div className="opt muted">No sessions match.</div>}
      </div>
    </Modal>
  );
}

export function RenameDialog({ id }: { id: string }) {
  const sess = useStore((s) => s.snapshot?.sessions.find((x) => x.id === id));
  const [name, setName] = useState(sess?.name ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const save = async () => {
    if (name.trim()) await rpc('sessions.rename', { id, name: name.trim() });
    close();
  };
  return (
    <Modal>
      <div className="modal-title">Rename session</div>
      <input ref={input} className="modal-input" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void save()} />
      <div className="modal-hint">↵ save · esc cancel</div>
    </Modal>
  );
}

export function OpenFileDialog() {
  const session = useStore((s) => activeSession(s));
  const root = sessionRoot(session);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    if (root) void repoFiles(root).then(setFiles);
  }, [root]);
  const filtered = useMemo(() => fuzzyFilter(files ?? [], query, (f) => f.path).slice(0, 80), [files, query]);
  const [sel, setSel, navKey] = useListNav(filtered.length);
  const open = (f: FileEntry | undefined) => {
    if (!f || !root) return;
    setState({ dialog: null });
    openInViewer({ path: `${root}/${f.path}`, root, mode: 'file' });
  };
  return (
    <Modal wide>
      <input ref={input} className="modal-input" placeholder={root ? `Open file in ${root.split('/').pop()}…` : 'No session selected'}
        value={query} onChange={(e) => { setQuery(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (navKey(e)) e.preventDefault();
          else if (e.key === 'Enter') { e.preventDefault(); open(filtered[sel]); }
        }} />
      <div className="opt-list">
        {files === null && <div className="opt muted">Loading files…</div>}
        {filtered.map((f, i) => (
          <div key={f.path} className={`opt file-opt ${i === sel ? 'sel' : ''}`} onMouseMove={() => i !== sel && setSel(i)} onClick={() => open(f)}>
            <span className={`opt-name ${statusClass(f.status)}`}>{f.path.split('/').pop()}</span>
            <span className="opt-path">{f.path}</span>
          </div>
        ))}
      </div>
      <div className="modal-hint">↑↓ pick · ↵ open in viewer · esc cancel</div>
    </Modal>
  );
}
