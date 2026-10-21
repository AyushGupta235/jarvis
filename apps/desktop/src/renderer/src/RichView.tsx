import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RichConversation, RichEnvelope, RichEvent, RichInfo, SessionInfo } from '@jarvis/protocol';
import { ago, isLocalUrl, openInViewer, openPreview, rpc, sessionRoot, setState, useStore } from './store';
import { Prose } from './ProseView';
import { setDensity } from './actions';
import { foldThinking } from './thinkingFold';
import { shortenCommand, shortenPaths } from './toolText';
import { DENSITIES } from '../../shared/themes';
import {
  EFFORT_LEVELS, PERMISSION_MODES, PICKER_COMMANDS, commandCatalog, matchCommands, parseCommand, type Command,
} from './richCommands';

/** One line describing a tool call, like the Activity tab. */
function toolLine(tool: string, input: unknown, cwd = ''): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const one = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 220);
  const home = window.jarvis.homeDir;
  if (tool === 'Bash') return one(shortenCommand(str(i.command), cwd, home));
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return shortenPaths(str(i.file_path) || str(i.notebook_path), cwd, home);
  if (tool === 'Grep' || tool === 'Glob') return `${str(i.pattern)}${i.path ? `  in ${shortenPaths(str(i.path), cwd, home)}` : ''}`;
  if (tool === 'Agent' || tool === 'Task') return one(str(i.description) || str(i.prompt));
  if (tool === 'WebFetch') return str(i.url);
  if (tool === 'WebSearch') return str(i.query);
  return one(JSON.stringify(input ?? {}));
}

function onPlan(src: string | null): boolean {
  return src === 'none' || src === 'oauth' || src === '/login managed key';
}

function authLabel(src: string | null): string | null {
  if (!src) return null;
  if (onPlan(src)) return 'your Claude plan';
  if (src === 'ANTHROPIC_API_KEY') return 'API key';
  return src;
}

function fmtBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1 << 20)).toFixed(1)} MB`;
}

type Ev<K extends RichEvent['kind']> = Extract<RichEvent, { kind: K }>;

interface PickItem {
  key: string;
  label: string;
  detail?: string;
  badge?: string;
  current?: boolean;
}

/** A small list picker over the composer, for /resume, /model, /permissions and friends. */
function Picker({ title, items, onPick, onClose, empty }: {
  title: string; items: PickItem[] | null; onPick?: (it: PickItem) => void; onClose: () => void; empty?: string;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = useMemo(() => {
    const n = q.toLowerCase();
    return (items ?? []).filter((it) => !n || `${it.label} ${it.detail ?? ''}`.toLowerCase().includes(n));
  }, [items, q]);
  useEffect(() => setSel(0), [q]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector('.rv-pick.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  return (
    <div className="rv-picker" onMouseDown={(e) => e.stopPropagation()}>
      <div className="rv-picker-head">
        <span className="rv-picker-title">{title}</span>
        <span className="strip-spacer" />
        <button className="chip-btn ghost" onClick={onClose}>esc</button>
      </div>
      {onPick && (
        <input autoFocus className="rv-picker-filter" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, list.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); const it = list[sel]; if (it) onPick(it); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }} />
      )}
      <div className="rv-picker-list" ref={box} tabIndex={onPick ? undefined : 0}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        {items === null && <div className="rv-pick muted">Loading…</div>}
        {items !== null && !list.length && <div className="rv-pick muted">{empty ?? 'Nothing here.'}</div>}
        {list.map((it, i) => (
          <div key={it.key} className={`rv-pick${onPick && i === sel ? ' sel' : ''}${onPick ? '' : ' static'}`}
            onMouseMove={() => onPick && i !== sel && setSel(i)} onClick={() => onPick?.(it)}>
            <span className="rv-pick-label">{it.label}{it.current && <span className="rv-pick-current">current</span>}</span>
            {it.detail && <span className="rv-pick-detail">{it.detail}</span>}
            {it.badge && <span className="rv-pick-badge">{it.badge}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Preview text for a thought: first line, without markdown markers. */
function thoughtLine(t: string): string {
  return t.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Normal density: every thought between two of Claude's messages, folded into one row. Closed, it shows the
 * newest thought (so you can follow along while it works); open, the whole stretch reads as paragraphs.
 */
function ThinkingGroup({ texts, sub }: { texts: string[]; sub: string }) {
  const [open, setOpen] = useState(false);
  const latest = thoughtLine(texts.at(-1) ?? '');
  return (
    <div className={`rv-think-group${open ? ' open' : ''}${sub}`}>
      <div className="rv-think-head" onClick={() => setOpen((o) => !o)}>
        <span className="rv-think-caret">{open ? '▾' : '▸'}</span>
        <span className="rv-think-tag">Thinking</span>
        {texts.length > 1 && <span className="rv-think-count">{texts.length} thoughts</span>}
        {!open && <span className="rv-think-preview">{latest.slice(0, 180)}</span>}
      </div>
      {open && texts.map((t, i) => <Prose key={i} text={t} className="rv-think-para" />)}
    </div>
  );
}

/** One run of the agent's work: its rows, plus what the collapsed summary needs. */
interface WorkRun {
  key: string;
  rows: React.ReactNode[];
  tools: { name: string; arg: string; state: 'running' | 'ok' | 'error' }[];
  thoughts: number;
}

/**
 * Tool calls and thinking are the agent working, not talking to you: each run of them sits in a recessed panel,
 * smaller and dimmer than Claude's messages. A run with several steps folds to one row ("6 steps · Read ×3 ·
 * Bash ×2") that shows the latest step while it works and opens to the individual calls.
 */
function WorkBlock({ run, startOpen }: { run: WorkRun; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  useEffect(() => setOpen(startOpen), [startOpen]);
  const steps = run.tools.length + (run.thoughts ? 1 : 0);
  if (run.rows.length <= 1 || steps <= 1) return <div className="rv-work">{run.rows}</div>;
  const counts = new Map<string, number>();
  for (const t of run.tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const names = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ');
  const running = run.tools.some((t) => t.state === 'running');
  const failed = run.tools.filter((t) => t.state === 'error').length;
  const latest = [...run.tools].reverse().find((t) => t.state === 'running') ?? run.tools.at(-1);
  return (
    <div className={`rv-work grouped${open ? ' open' : ''}`}>
      <div className="rv-work-head" onClick={() => setOpen((o) => !o)}>
        <span className={`rv-dot${running ? ' running' : ''}`}>{running ? '◌' : open ? '▾' : '▸'}</span>
        <span className="rv-work-count">{run.tools.length} {run.tools.length === 1 ? 'step' : 'steps'}</span>
        <span className="rv-work-names">{names}{run.thoughts ? ` · ${run.thoughts} thought${run.thoughts === 1 ? '' : 's'}` : ''}</span>
        {failed > 0 && <span className="rv-work-failed">{failed} failed</span>}
        {!open && latest && <span className="rv-work-latest">{latest.name} {latest.arg}</span>}
      </div>
      {open && <div className="rv-work-body">{run.rows}</div>}
    </div>
  );
}

function workRuns(
  rows: React.ReactNode[], events: RichEnvelope[], ends: Map<string, { isError: boolean }>, cwd: string,
): (React.ReactNode | WorkRun)[] {
  const out: (React.ReactNode | WorkRun)[] = [];
  let run: WorkRun | null = null;
  rows.forEach((el, i) => {
    if (!el) return;
    const e = events[i]!.event;
    if (e.kind === 'tool_start' || e.kind === 'thinking') {
      if (!run) out.push((run = { key: String(events[i]!.seq), rows: [], tools: [], thoughts: 0 }));
      run.rows.push(el);
      if (e.kind === 'thinking') run.thoughts++;
      else {
        const end = ends.get(e.toolUseId);
        run.tools.push({ name: e.tool, arg: toolLine(e.tool, e.input, cwd), state: !end ? 'running' : end.isError ? 'error' : 'ok' });
      }
    } else {
      run = null;
      out.push(el);
    }
  });
  return out;
}

type PickerState = { title: string; items: PickItem[] | null; onPick?: (it: PickItem) => void; empty?: string } | null;

const KIND_BADGE: Record<Command['kind'], string | undefined> = { sdk: undefined, jarvis: 'Jarvis', terminal: 'opens terminal' };

/**
 * A rich session, drawn by Jarvis from SDK events. The conversation lives in the session's host process and
 * Claude's transcript; this view renders it and sends what you type, with every slash command available
 * (richCommands.ts says how each one runs).
 */
export function RichView({ session, visible }: { session: SessionInfo; visible: boolean }) {
  const [events, setEvents] = useState<RichEnvelope[]>([]);
  const [draft, setDraft] = useState('');
  const [info, setInfo] = useState<RichInfo | null>(null);
  const [picker, setPicker] = useState<PickerState>(null);
  const [paletteSel, setPaletteSel] = useState(0);
  const [paletteHidden, setPaletteHidden] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const look = useStore((s) => s.appearanceVersion);
  const connected = !!session.rich?.connected;
  const hostPid = session.rich?.hostPid ?? null;

  useEffect(() => {
    let live = true;
    void rpc<{ events: RichEnvelope[] }>('rich.history', { id: session.id })
      .then((r) => live && setEvents(r.events))
      .catch(() => {});
    const off = window.jarvis.onRichEvent(({ sessionId, envelope }) => {
      if (sessionId !== session.id) return;
      setEvents((ev) => {
        const last = ev.at(-1)?.seq ?? 0;
        if (envelope.seq === 1) return [envelope]; // a new host (revive, /resume) starts its log over
        return envelope.seq > last ? [...ev, envelope] : ev;
      });
    });
    return () => {
      live = false;
      off();
    };
    // Refetch when a host (re)connects: revive and /resume restart it while this view stays open.
  }, [session.id, hostPid, connected]);

  // Commands, models and account, for the palette and pickers. The host knows them shortly after it starts.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const load = (tries: number) => void window.jarvis.rpc<RichInfo>('rich.info', { id: session.id })
      .then((r) => {
        if (!live) return;
        setInfo(r);
        if (!r.commands.length && tries > 0) setTimeout(() => load(tries - 1), 1500);
      })
      .catch(() => {});
    load(8);
    return () => {
      live = false;
    };
  }, [session.id, hostPid, connected]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => input.current?.focus());
  }, [visible]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    const onQuote = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; text: string }>).detail;
      if (d.id !== session.id) return;
      setDraft((cur) => `${d.text}${cur}`);
      window.getSelection()?.removeAllRanges();
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener('jarvis:quote', onQuote);
    return () => window.removeEventListener('jarvis:quote', onQuote);
  }, [session.id]);

  const { ends, resolved, lastReply, status } = useMemo(() => {
    const ends = new Map<string, Ev<'tool_end'>>();
    const resolved = new Map<string, 'allow' | 'deny'>();
    let lastReply = '';
    let status: Ev<'status'> | null = null;
    let turnText: string[] = [];
    for (const { event: e } of events) {
      if (e.kind === 'tool_end') ends.set(e.toolUseId, e);
      else if (e.kind === 'permission_resolved') resolved.set(e.requestId, e.behavior);
      else if (e.kind === 'status') status = e;
      else if (e.kind === 'user') turnText = [];
      else if (e.kind === 'text' && !e.parentToolUseId) {
        turnText.push(e.text);
        lastReply = turnText.join('\n\n');
      }
    }
    return { ends, resolved, lastReply, status };
  }, [events]);

  const density = useStore((s) => s.richDensity);
  const thinking = useMemo(() => foldThinking(events), [events]);

  const catalog = useMemo(() => commandCatalog(info), [info]);
  const paletteQuery = /^\/([\w:.@-]*)$/.exec(draft)?.[1];
  const palette = paletteQuery !== undefined && !paletteHidden && !picker ? matchCommands(catalog, paletteQuery).slice(0, 60) : null;
  useEffect(() => setPaletteSel(0), [paletteQuery]);
  useEffect(() => {
    if (!draft.startsWith('/')) setPaletteHidden(false);
  }, [draft]);

  const sendText = async (text: string) => {
    stick.current = true;
    await rpc('rich.send', { id: session.id, text }).catch(() => setDraft(text));
  };

  const openTerminal = async (command: string | null) => {
    await rpc('sessions.switchMode', { id: session.id, mode: 'terminal', command }).catch(() => {});
  };

  /** Run a slash command the way richCommands.ts says it runs. */
  const runCommand = async (text: string): Promise<void> => {
    const cmd = parseCommand(text)!;
    const known = catalog.find((c) => c.name === cmd.name);
    const pickAndSend = (title: string, items: PickItem[], build: (it: PickItem) => string) =>
      setPicker({ title, items, onPick: (it) => { setPicker(null); void sendText(build(it)); } });
    switch (known?.kind === 'jarvis' ? cmd.name : '') {
      case 'resume': {
        setPicker({ title: 'Resume a conversation in this directory', items: null, empty: 'No saved conversations here yet.' });
        const list = await rpc<RichConversation[]>('rich.conversations', { id: session.id }).catch(() => [] as RichConversation[]);
        const items = list.map((c): PickItem => ({
          key: c.agentSessionId, label: c.title.replace(/\s+/g, ' ').slice(0, 120), current: c.current,
          detail: [ago(c.lastModified) + ' ago', c.branch, fmtBytes(c.sizeBytes), c.agentSessionId.slice(0, 8)].filter(Boolean).join(' · '),
        }));
        const direct = cmd.args && list.find((c) => c.agentSessionId.startsWith(cmd.args));
        if (direct) {
          setPicker(null);
          await rpc('rich.resume', { id: session.id, agentSessionId: direct.agentSessionId }).catch(() => {});
          return;
        }
        setPicker({
          title: 'Resume a conversation in this directory', items, empty: 'No saved conversations here yet.',
          onPick: (it) => {
            setPicker(null);
            if (!it.current) void rpc('rich.resume', { id: session.id, agentSessionId: it.key }).catch(() => {});
          },
        });
        return;
      }
      case 'permissions':
        setPicker({
          title: 'Permission mode',
          items: PERMISSION_MODES.map((m) => ({ key: m.value, label: m.label, detail: m.detail, current: status?.permissionMode === m.value })),
          onPick: (it) => {
            setPicker(null);
            void rpc('rich.setPermissionMode', { id: session.id, mode: it.key }).catch(() => {});
          },
        });
        return;
      case 'status': {
        const a = info?.account;
        const rows: [string, string | null | undefined][] = [
          ['Model', status?.model ?? info?.model], ['Permission mode', status?.permissionMode ?? info?.permissionMode],
          ['Billing', authLabel(status?.authSource ?? a?.authSource ?? null)], ['Account', a?.email],
          ['Organization', a?.organization], ['Plan', a?.subscription], ['Claude Code', info?.version],
          ['Directory', session.cwd], ['Conversation', status?.agentSessionId ?? session.agentSessionId],
          ['Host process', session.rich?.hostPid ? String(session.rich.hostPid) : null],
        ];
        setPicker({ title: 'Status', items: rows.filter(([, v]) => v).map(([k, v]) => ({ key: k, label: k, detail: v! })) });
        return;
      }
      case 'copy':
        if (!lastReply) setNote('Nothing to copy yet');
        else {
          window.jarvis.copyText(lastReply);
          setNote("Copied Claude's last reply");
        }
        return;
      case 'export': {
        const r = await rpc<{ path: string }>('rich.export', { id: session.id }).catch(() => null);
        if (r) {
          setNote(`Saved ${r.path.replace(window.jarvis.homeDir, '~')}`);
          openInViewer({ path: r.path, root: null, mode: 'file' });
        }
        return;
      }
      case 'memory':
        setState({ navOpen: true, navTab: 'docs' });
        setNote('CLAUDE.md files are in the Docs tab');
        return;
      case 'help':
        setDraft('/');
        setPaletteHidden(false);
        return;
      case 'exit':
        await rpc('sessions.kill', { id: session.id }).catch(() => {});
        return;
      default:
        break;
    }
    if (known?.kind === 'terminal') {
      await openTerminal(text.trim());
      return;
    }
    if (!cmd.args && PICKER_COMMANDS.has(cmd.name) && known) {
      if (cmd.name === 'model') {
        const current = status?.model ?? info?.model;
        return pickAndSend('Model', (info?.models ?? []).map((m) => ({
          key: m.value, label: m.displayName, detail: m.description, current: !!current && (current === m.value || current.includes(m.value)),
        })), (it) => `/model ${it.key}`);
      }
      if (cmd.name === 'effort') return pickAndSend('Effort', EFFORT_LEVELS.map((e) => ({ key: e.value, label: e.value, detail: e.detail })), (it) => `/effort ${it.key}`);
      if (cmd.name === 'output-style') return pickAndSend('Output style', (info?.outputStyles ?? []).map((s) => ({ key: s, label: s })), (it) => `/output-style ${it.key}`);
    }
    await sendText(text.trim());
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || !connected) return;
    setDraft('');
    if (parseCommand(text)) await runCommand(text);
    else await sendText(text);
  };

  const respond = (requestId: string, behavior: 'allow' | 'deny') =>
    void rpc('rich.respond', { id: session.id, requestId, behavior }).catch(() => {});
  const working = session.agentState?.phase === 'working';

  /** Clicks inside replies: copy and expand code blocks, open file paths and links. */
  const onProseClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]');
    if (act?.dataset.act === 'copy') {
      const code = act.closest('.pc-block')?.querySelector('pre')?.textContent ?? '';
      window.jarvis.copyText(code);
      act.textContent = 'Copied';
      setTimeout(() => (act.textContent = 'Copy'), 1400);
      return;
    }
    if (act?.dataset.act === 'expand') {
      act.closest('.pc-block')?.classList.remove('collapsed');
      return;
    }
    const path = t.closest<HTMLElement>('[data-path]')?.dataset.path;
    if (path) {
      const [p, ln] = path.split(':');
      const home = window.jarvis.homeDir;
      const abs = p!.startsWith('/') ? p! : p!.startsWith('~') ? home + p!.slice(1) : `${session.cwd}/${p!.replace(/^\.\//, '')}`;
      openInViewer({ path: abs, root: sessionRoot(session), mode: 'file', line: ln ? Number(ln) : undefined });
      return;
    }
    const href = t.closest<HTMLElement>('[data-href]')?.dataset.href;
    if (href && /^https?:\/\//.test(href)) {
      if (isLocalUrl(href)) openPreview(href);
      else window.jarvis.openExternal(href);
    }
  };

  let lastStatus = '';
  const rows = events.map(({ seq, event: e, replay }) => {
    const key = `${seq}`;
    const sub = 'parentToolUseId' in e && e.parentToolUseId ? ' rv-sub' : '';
    switch (e.kind) {
      case 'user':
        return <div key={key} className={`rv-user${replay ? ' replay' : ''}`}><span className="rv-caret">›</span>{e.text}</div>;
      case 'text':
        return <Prose key={key} text={e.text} className={`rv-text${sub}`} />;
      case 'thinking': {
        if (density === 'focus') return null;
        if (density === 'detailed') {
          return (
            <div key={key} className={`rv-think-open${sub}`}>
              <span className="rv-think-tag">Thinking</span>
              <Prose text={e.text} className="rv-think-para" />
            </div>
          );
        }
        if (thinking.folded.has(seq)) return null;
        return <ThinkingGroup key={key} texts={thinking.groups.get(seq) ?? [e.text]} sub={sub} />;
      }
      case 'tool_start': {
        const end = ends.get(e.toolUseId);
        const state = !end ? 'running' : end.isError ? 'error' : 'ok';
        return (
          <details key={key} className={`rv-tool ${state}${sub}${density === 'detailed' ? ' compact' : ''}`} open={state === 'error'}>
            <summary>
              <span className="rv-dot">{state === 'running' ? '◌' : state === 'error' ? '✗' : '⏺'}</span>
              <span className="rv-tool-name">{e.tool}</span>
              <span className="rv-tool-arg">{toolLine(e.tool, e.input, session.cwd)}</span>
            </summary>
            <pre className="rv-io">{JSON.stringify(e.input, null, 2)}</pre>
            {end && <pre className={`rv-io out${end.isError ? ' err' : ''}`}>{end.output || '(no output)'}</pre>}
          </details>
        );
      }
      case 'permission_request': {
        const done = resolved.get(e.requestId);
        if (done || replay) {
          return <div key={key} className="rv-note">{done === 'deny' ? 'Denied' : 'Allowed'} {e.tool}</div>;
        }
        return (
          <div key={key} className="rv-perm">
            <div className="rv-perm-title">Allow <b>{e.tool}</b>?</div>
            <div className="rv-perm-arg">{toolLine(e.tool, e.input, session.cwd)}</div>
            {e.reason && <div className="rv-perm-reason">{e.reason}</div>}
            <div className="rv-perm-actions">
              <button className="btn primary" disabled={!connected} onClick={() => respond(e.requestId, 'allow')}>Allow</button>
              <button className="btn" disabled={!connected} onClick={() => respond(e.requestId, 'deny')}>Deny</button>
            </div>
          </div>
        );
      }
      case 'status': {
        const line = [e.model, e.permissionMode && `${e.permissionMode} permissions`, authLabel(e.authSource) && `on ${authLabel(e.authSource)}`]
          .filter(Boolean).join(' · ');
        if (line === lastStatus) return null;
        lastStatus = line;
        return <div key={key} className="rv-note">{line}</div>;
      }
      case 'turn_end': {
        const plan = onPlan(status?.authSource ?? null);
        const cost = e.costUsd ? `$${e.costUsd.toFixed(2)}` : null;
        return (
          <div key={key} className={`rv-turn${e.ok ? '' : ' err'}`}>
            {e.ok ? 'done' : `failed: ${e.error ?? 'unknown error'}`}
            {e.durationMs != null && ` · ${(e.durationMs / 1000).toFixed(1)}s`}
            {cost && (plan
              ? <span title="What this turn would cost at API prices. On your plan it counts against your limits instead."> · ≈{cost} API equiv.</span>
              : ` · ${cost}`)}
          </div>
        );
      }
      case 'compact':
        return <div key={key} className="rv-sep">context compacted</div>;
      case 'resumed':
        return <div key={key} className="rv-sep">resumed · {e.messages} messages from the transcript</div>;
      case 'error':
        return <div key={key} className="rv-error">{e.message}</div>;
      case 'ended':
        return <div key={key} className="rv-sep">session ended: {e.reason}</div>;
      default:
        return null;
    }
  });

  return (
    <div className="rich-wrap" style={{ display: visible ? 'flex' : 'none' }} onMouseDown={() => picker && setPicker(null)}>
      <div className="rv-scroll" ref={box} onClick={onProseClick} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        <div className="rv-column" key={look}>
          {!events.length && <div className="rv-empty">{connected ? 'Send a message to start. Type / for commands.' : 'Connecting to the session…'}</div>}
          {workRuns(rows, events, ends, session.cwd).map((x) => (x && typeof x === 'object' && 'tools' in x
            ? <WorkBlock key={`work-${x.key}`} run={x} startOpen={density === 'detailed'} />
            : x))}
        </div>
      </div>
      <div className="rv-composer">
        {picker && <Picker {...picker} onClose={() => { setPicker(null); input.current?.focus(); }} />}
        {palette && palette.length > 0 && (
          <div className="rv-palette" onMouseDown={(e) => e.preventDefault()}>
            {palette.map((c, i) => (
              <div key={c.name} className={`rv-cmd${i === paletteSel ? ' sel' : ''}`} ref={(el) => { if (i === paletteSel) el?.scrollIntoView({ block: 'nearest' }); }}
                onMouseMove={() => i !== paletteSel && setPaletteSel(i)}
                onClick={() => { setDraft(''); void runCommand(`/${c.name}`); }}>
                <span className="rv-cmd-name">/{c.name}</span>
                {c.hint && <span className="rv-cmd-hint">{c.hint}</span>}
                <span className="rv-cmd-desc">{c.description}</span>
                {KIND_BADGE[c.kind] && <span className={`rv-cmd-badge ${c.kind}`}>{KIND_BADGE[c.kind]}</span>}
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          className="rv-input"
          rows={Math.min(10, Math.max(2, draft.split('\n').length))}
          placeholder={connected ? 'Message Claude (↵ send · ⇧↵ newline · / commands · esc interrupt)' : 'Not connected'}
          value={draft}
          disabled={!connected}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (palette && palette.length) {
              const c = palette[paletteSel];
              if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteSel((s) => Math.min(s + 1, palette.length - 1)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteSel((s) => Math.max(s - 1, 0)); return; }
              if (e.key === 'Tab' && c) { e.preventDefault(); setDraft(`/${c.name} `); return; }
              if (e.key === 'Escape') { e.preventDefault(); setPaletteHidden(true); return; }
              if (e.key === 'Enter' && !e.shiftKey && c) {
                e.preventDefault();
                // A command that needs an argument gets completed so you can type it; the rest run now.
                if (c.hint.startsWith('<') && c.kind !== 'jarvis' && !PICKER_COMMANDS.has(c.name)) setDraft(`/${c.name} `);
                else { setDraft(''); void runCommand(`/${c.name}`); }
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape' && working) {
              e.preventDefault();
              void rpc('rich.interrupt', { id: session.id }).catch(() => {});
            }
          }}
        />
        <div className="rv-composer-bar">
          <span className="muted">{working ? `working${session.agentState?.tool ? `: ${session.agentState.tool}` : ''}` : connected ? 'ready' : 'disconnected'}</span>
          {note && <span className="rv-toast">{note}</span>}
          <span className="strip-spacer" />
          <div className="seg small rv-density" title="How much thinking to show (⌥⌘T)">
            {DENSITIES.map((d) => (
              <button key={d.id} className={`seg-btn ${density === d.id ? 'on' : ''}`} title={`${d.detail} (⌥⌘T cycles)`}
                onClick={() => setDensity(d.id)}>{d.label}</button>
            ))}
          </div>
          <button className="chip-btn ghost" title="Reopen this conversation in Claude Code's own screen" disabled={!connected}
            onClick={() => void openTerminal(null)}>Open in terminal</button>
          {working && <button className="chip-btn" onClick={() => void rpc('rich.interrupt', { id: session.id }).catch(() => {})}>Interrupt <kbd>esc</kbd></button>}
          <button className="chip-btn" disabled={!connected || !draft.trim()} onClick={() => void submit()}>Send <kbd>↵</kbd></button>
        </div>
      </div>
    </div>
  );
}

