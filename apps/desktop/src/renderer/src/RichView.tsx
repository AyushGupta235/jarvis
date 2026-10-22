import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RichContext, RichConversation, RichEnvelope, RichEvent, RichInfo, RichMcpServer, RichQuestion, SessionInfo } from '@jarvis/protocol';
import { ago, isLocalUrl, openInViewer, openPreview, rpc, sessionRoot, setState, useStore } from './store';
import { Prose } from './ProseView';
import { ContextPanel } from './ContextPanel';
import { setDensity } from './actions';
import { foldThinking } from './thinkingFold';
import { resolveLocalHref, toolLine } from './toolText';
import { DENSITIES } from '../../shared/themes';
import { AgentCard, type AgentCtx, BtwCard, RunAgentPanel, ShellCard, agentRequest, CompactMarker, CompactSummary, Compacting, TaskNotices, UserMessage, fmtDuration, isAgentTool, taskByTool } from './RichParts';
import {
  EFFORT_LEVELS, PERMISSION_MODES, PICKER_COMMANDS, canonicalName, commandCatalog, matchCommands, parseCommand, type Command,
} from './richCommands';
import { THEMES } from '../../shared/themes';
import { shellContext, type ShellRun } from './shellText';
import { setAppearance } from './actions';

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

/**
 * Claude's multiple-choice question: each question with its options as cards (radio, or checkboxes when more
 * than one can be picked), an "Other" box for your own answer, and Send or Skip. Your answer goes back to
 * Claude, which carries on with it.
 */
function QuestionCard({ questions, disabled, from, onAnswer, onSkip }: {
  questions: RichQuestion[]; disabled: boolean; from?: string | null;
  onAnswer: (answers: Record<string, string | string[]>) => void; onSkip: () => void;
}) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const answerFor = (i: number): string | string[] | null => {
    const q = questions[i]!;
    const chosen = picked[i] ?? [];
    const own = (other[i] ?? '').trim();
    if (q.multiSelect) return chosen.length || own ? [...chosen, ...(own ? [own] : [])] : null;
    return own || chosen[0] || null;
  };
  const complete = questions.every((_, i) => answerFor(i) != null);
  const toggle = (i: number, label: string, multi: boolean) => setPicked((p) => {
    const cur = p[i] ?? [];
    const next = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
    return { ...p, [i]: next };
  });
  return (
    <div className="rv-ask">
      <div className="rv-ask-title">{from ? `Sub-agent asking: ${from}` : 'Claude is asking'}</div>
      {questions.map((q, i) => (
        <div key={i} className="rv-ask-q">
          <div className="rv-ask-head">{q.header && <span className="rv-ask-tag">{q.header}</span>}<span>{q.question}</span></div>
          <div className="rv-ask-options">
            {q.options.map((o) => {
              const on = (picked[i] ?? []).includes(o.label) && !(other[i] ?? '').trim();
              return (
                <button key={o.label} className={`rv-ask-opt${on ? ' on' : ''}`} disabled={disabled}
                  onClick={() => { setOther((x) => ({ ...x, [i]: q.multiSelect ? (x[i] ?? '') : '' })); toggle(i, o.label, q.multiSelect); }}>
                  <span className={`rv-ask-mark${q.multiSelect ? ' box' : ''}`}>{on ? '✓' : ''}</span>
                  <span className="rv-ask-label">{o.label}</span>
                  {o.description && <span className="rv-ask-desc">{o.description}</span>}
                </button>
              );
            })}
            <input className="rv-ask-other" placeholder="Something else…" value={other[i] ?? ''} disabled={disabled}
              onChange={(e) => setOther((x) => ({ ...x, [i]: e.target.value }))} />
          </div>
        </div>
      ))}
      <div className="rv-ask-actions">
        <button className="btn primary" disabled={disabled || !complete}
          onClick={() => onAnswer(Object.fromEntries(questions.map((q, i) => [q.question, answerFor(i)!])))}>Send answer</button>
        <button className="btn" disabled={disabled} onClick={onSkip}>Skip</button>
      </div>
    </div>
  );
}

/**
 * Messages you sent while Claude works, held in Jarvis until it is ready for them. Each can be edited, removed, or
 * sent now (which stops the current turn so Claude takes it straight away). Ones already handed to Claude are
 * shown dimmed until it reads them.
 */
function QueueTray({ items, paused, onAction }: {
  items: { uuid: string; text: string; sent: boolean }[];
  paused: boolean;
  onAction: (uuid: string, action: 'edit' | 'remove' | 'sendNow', text?: string) => void;
}) {
  const [editing, setEditing] = useState<{ uuid: string; text: string } | null>(null);
  const save = () => {
    if (editing && editing.text.trim()) onAction(editing.uuid, 'edit', editing.text);
    setEditing(null);
  };
  return (
    <div className="rv-queue">
      <div className="rv-queue-title">
        {paused ? 'Stopped · these are held until you send them' : 'Queued · held here until Claude is ready; edit, remove or send now'}
      </div>
      {items.map((it) => (
        <div key={it.uuid} className={`rv-queue-item${it.sent ? ' sent' : ''}`}>
          {editing?.uuid === it.uuid ? (
            <>
              <textarea className="rv-queue-edit" autoFocus rows={Math.min(8, Math.max(2, editing.text.split('\n').length))} value={editing.text}
                onChange={(e) => setEditing({ uuid: it.uuid, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
                  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
                }} />
              <span className="rv-queue-actions">
                <button className="chip-btn" onClick={save} disabled={!editing.text.trim()}>Save <kbd>↵</kbd></button>
                <button className="chip-btn" onClick={() => setEditing(null)}>Cancel <kbd>esc</kbd></button>
              </span>
            </>
          ) : (
            <>
              <span className="rv-queue-text">{it.text}</span>
              {it.sent ? <span className="rv-queue-state">with Claude</span> : (
                <span className="rv-queue-actions">
                  <button className="chip-btn" title="Stop the current turn and send this now" onClick={() => onAction(it.uuid, 'sendNow')}>Send now</button>
                  <button className="chip-btn" onClick={() => setEditing({ uuid: it.uuid, text: it.text })}>Edit</button>
                  <button className="chip-btn" title="Remove from the queue" onClick={() => onAction(it.uuid, 'remove')}>✕</button>
                </span>
              )}
            </>
          )}
        </div>
      ))}
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
/** Background and Stop sit on the work that's running, where you're already looking. */
function WorkActions({ run, actions }: { run: WorkRun; actions: WorkControls }) {
  const live = [...run.tools].reverse().find((t) => t.state === 'running');
  if (!live) return null;
  return (
    <div className="rv-work-actions" onClick={(e) => e.stopPropagation()}>
      {live.name === 'Bash' && (
        <button className="chip-btn" title="Move the running command to the background so Claude carries on" onClick={actions.background}>
          Background <kbd>⌃B</kbd>
        </button>
      )}
      <button className="chip-btn" title="Stop this turn" onClick={actions.stop}>Stop <kbd>esc</kbd></button>
    </div>
  );
}

interface WorkControls {
  background: () => void;
  stop: () => void;
}

function WorkBlock({ run, startOpen, actions }: { run: WorkRun; startOpen: boolean; actions: WorkControls }) {
  const [open, setOpen] = useState(startOpen);
  useEffect(() => setOpen(startOpen), [startOpen]);
  const steps = run.tools.length + (run.thoughts ? 1 : 0);
  if (run.rows.length <= 1 || steps <= 1) return <div className="rv-work"><WorkActions run={run} actions={actions} />{run.rows}</div>;
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
        <WorkActions run={run} actions={actions} />
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
    if ((e.kind === 'tool_start' && !isAgentTool(e.tool)) || e.kind === 'thinking') {
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

/** Unsent composer text per session, kept while the view is unmounted. */
const drafts = new Map<string, string>();
/** `!` commands already sent to Claude with a message, and ones you took off, per session. */
const shellSent = new Map<string, Set<string>>();
const shellDismissed = new Map<string, Set<string>>();
const idSet = (m: Map<string, Set<string>>, id: string): Set<string> => m.get(id) ?? m.set(id, new Set()).get(id)!;

const ACCENTS: Record<string, string> = {
  red: '#e5484d', blue: '#3e8ef7', green: '#30a46c', yellow: '#e5b800', purple: '#8e4ec6', orange: '#f76b15', pink: '#d6409f', cyan: '#12a594',
};

const KIND_BADGE: Record<Command['kind'], string | undefined> = { sdk: undefined, jarvis: 'Jarvis', terminal: 'opens terminal', link: 'opens page', note: 'info' };

/**
 * A rich session, drawn by Jarvis from SDK events. The conversation lives in the session's host process and
 * Claude's transcript; this view renders it and sends what you type, with every slash command available
 * (richCommands.ts says how each one runs).
 */
export function RichView({ session, visible }: { session: SessionInfo; visible: boolean }) {
  const [events, setEvents] = useState<RichEnvelope[]>([]);
  // The draft lives outside the component: restarting a session (rewind, /resume, /cd) unmounts the view for a moment,
  // and what you were typing, or the prompt a rewind puts back, must survive that.
  const [draft, setDraftState] = useState(() => drafts.get(session.id) ?? '');
  const setDraft = (v: string | ((cur: string) => string)) => setDraftState((cur) => {
    const next = typeof v === 'function' ? v(cur) : v;
    drafts.set(session.id, next);
    return next;
  });
  useEffect(() => {
    const sync = (e: Event) => {
      if ((e as CustomEvent<{ id: string }>).detail.id === session.id) setDraftState(drafts.get(session.id) ?? '');
    };
    window.addEventListener('jarvis:draft', sync);
    return () => window.removeEventListener('jarvis:draft', sync);
  }, [session.id]);
  const [info, setInfo] = useState<RichInfo | null>(null);
  const [picker, setPicker] = useState<PickerState>(null);
  const [runAgent, setRunAgent] = useState<{ agents: { name: string; description: string; model: string | null }[]; prompt: string; background: boolean } | null>(null);
  const [accent, setAccent] = useState(() => { try { return localStorage.getItem(`jarvis.rv.accent.${session.id}`) ?? ''; } catch { return ''; } });
  const [context, setContext] = useState<RichContext | 'loading' | null>(null);
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

  // A hidden session loses its scroll offset, so on show: back to the bottom if you were following the
  // conversation, else to where you were reading.
  const savedTop = useRef(0);
  const userScroll = useRef(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!visible || !el) return;
    el.scrollTop = stick.current ? el.scrollHeight : savedTop.current;
  }, [visible]);

  // Content keeps growing after it renders (code highlighting, tables, images, loaded history). While you're
  // following the conversation, stay pinned to the bottom as it does.
  useEffect(() => {
    const col = box.current?.firstElementChild;
    if (!col) return;
    const ro = new ResizeObserver(() => {
      const el = box.current;
      if (el && stick.current && visible) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, [visible, look]);

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

  const { ends, resolved, answersById, lastReply, replies, status } = useMemo(() => {
    const ends = new Map<string, Ev<'tool_end'>>();
    const resolved = new Map<string, 'allow' | 'deny'>();
    const answersById = new Map<string, Record<string, string | string[]>>();
    let lastReply = '';
    const replies: string[] = [];
    let status: Ev<'status'> | null = null;
    let turnText: string[] = [];
    for (const { event: e } of events) {
      if (e.kind === 'tool_end') ends.set(e.toolUseId, e);
      else if (e.kind === 'permission_resolved') {
        resolved.set(e.requestId, e.behavior);
        if (e.answers) answersById.set(e.requestId, e.answers);
      }
      else if (e.kind === 'status') status = e;
      else if (e.kind === 'user') turnText = [];
      else if (e.kind === 'text' && !e.parentToolUseId) {
        turnText.push(e.text);
        lastReply = turnText.join('\n\n');
      } else if (e.kind === 'turn_end' && turnText.length) {
        replies.push(turnText.join('\n\n'));
        turnText = [];
      }
    }
    if (turnText.length) replies.push(turnText.join('\n\n'));
    return { ends, resolved, answersById, lastReply, replies, status };
  }, [events]);

  const density = useStore((s) => s.richDensity);
  const thinking = useMemo(() => foldThinking(events), [events]);
  // Sub-agents own their steps, and a task's reports stack: both are drawn once, where they start.
  const structure = useMemo(() => {
    const agents = new Set<string>();
    const starts = new Map<string, Ev<'tool_start'>>();
    for (const { event: e } of events) if (e.kind === 'tool_start' && isAgentTool(e.tool)) { agents.add(e.toolUseId); starts.set(e.toolUseId, e); }
    const kids = new Map<string, RichEnvelope[]>();
    const hidden = new Set<number>();
    const notices = new Map<number, Ev<'task_notice'>[]>();
    const reports = new Map<string, Ev<'task_notice'>>();
    let group: { seq: number; taskId: string; list: Ev<'task_notice'>[] } | null = null;
    const btw = new Map<string, Ev<'btw'>>();
    const shellSeen = new Set<string>();
    const toolOfTask = new Map<string, string>();
    for (const { event: e } of events) {
      if (e.kind === 'task' && e.toolUseId) toolOfTask.set(e.taskId, e.toolUseId);
      // History has no task events; an agent's tool result still names it.
      else if (e.kind === 'tool_end' && agents.has(e.toolUseId)) {
        const id = /agentId: (\w+)/.exec(e.output)?.[1] ?? /from "(\w+)"/.exec(e.output)?.[1];
        if (id) toolOfTask.set(id, e.toolUseId);
      }
    }
    let lastCompacting = -1;
    let lastCompact = -1;
    for (const env of events) {
      const e = env.event;
      if ('parentToolUseId' in e && e.parentToolUseId && agents.has(e.parentToolUseId)) {
        hidden.add(env.seq);
        const list = kids.get(e.parentToolUseId) ?? [];
        list.push(env);
        kids.set(e.parentToolUseId, list);
        continue;
      }
      if (e.kind === 'shell' || e.kind === 'shell_out') {
        // One card per command, where it started.
        if (shellSeen.has(e.id)) hidden.add(env.seq);
        shellSeen.add(e.id);
        continue;
      }
      if (e.kind === 'btw') {
        // One card per question: it sits where the question was asked and shows the latest state.
        if (btw.has(e.id)) hidden.add(env.seq);
        btw.set(e.id, e);
        continue;
      }
      if (e.kind === 'task' || e.kind === 'context') continue; // not drawn, so they don't separate a run of reports
      if (e.kind === 'task_notice') {
        // A sub-agent's report belongs in its card.
        const owner = e.toolUseId ?? toolOfTask.get(e.taskId);
        if (owner && agents.has(owner)) {
          // A bare completion (no text) must not replace the report that carries the answer.
          if (e.status !== 'event' && (e.event || !reports.get(owner)?.event)) reports.set(owner, e);
          hidden.add(env.seq);
          continue;
        }
        if (group && group.taskId === e.taskId) {
          group.list.push(e);
          hidden.add(env.seq);
        } else {
          group = { seq: env.seq, taskId: e.taskId, list: [e] };
          notices.set(env.seq, group.list);
        }
        continue;
      }
      group = null;
      if (e.kind === 'compacting') lastCompacting = env.seq;
      else if (e.kind === 'compact') lastCompact = env.seq;
    }
    return { kids, hidden, notices, reports, btw, starts, compactingSeq: lastCompacting > lastCompact ? lastCompacting : -1, tasks: taskByTool(events) };
  }, [events]);

  // Background commands and sub-agents, latest state per task, for /tasks.
  const taskStates = useMemo(() => {
    const m = new Map<string, Ev<'task'>>();
    for (const { event: e } of events) {
      if (e.kind !== 'task') continue;
      const prev = m.get(e.taskId);
      m.set(e.taskId, prev ? { ...prev, ...e, description: e.description ?? prev.description, agentType: e.agentType ?? prev.agentType, tools: e.tools ?? prev.tools, durationMs: e.durationMs ?? prev.durationMs, progress: e.progress ?? prev.progress } : e);
    }
    return m;
  }, [events]);

  // `!` commands: what each printed and how it ended, from their events.
  const [shellTick, bumpShell] = useState(0);
  const shellRuns = useMemo(() => {
    const m = new Map<string, ShellRun>();
    for (const { event: e } of events) {
      if (e.kind === 'shell') m.set(e.id, { id: e.id, command: e.command, output: m.get(e.id)?.output ?? '', state: e.state, exitCode: e.exitCode });
      else if (e.kind === 'shell_out') {
        const r = m.get(e.id);
        if (r) r.output += e.text;
      }
    }
    return m;
  }, [events]);
  /** Finished commands that have not gone to Claude yet and that you have not taken off. */
  const pendingShell = [...shellRuns.values()].filter((r) => r.state !== 'running' && !idSet(shellSent, session.id).has(r.id) && !idSet(shellDismissed, session.id).has(r.id));
  void shellTick;

  /** Which sub-agent a request came from, in words ("Explore · map docs"). */
  const agentLabel = (agentId: string | null | undefined): string | null => {
    if (!agentId) return null;
    const t = taskStates.get(agentId);
    const st = t?.toolUseId ? structure.starts.get(t.toolUseId) : undefined;
    const inp = (st?.input ?? {}) as { description?: string; subagent_type?: string };
    return [t?.agentType ?? inp.subagent_type, inp.description].filter(Boolean).join(' · ') || 'a sub-agent';
  };

  const catalog = useMemo(() => commandCatalog(info), [info]);
  const paletteQuery = /^\/([\w:.@-]*)$/.exec(draft)?.[1];
  const palette = paletteQuery !== undefined && !paletteHidden && !picker ? matchCommands(catalog, paletteQuery).slice(0, 400) : null;
  useEffect(() => setPaletteSel(0), [paletteQuery]);
  useEffect(() => {
    if (!draft.startsWith('/')) setPaletteHidden(false);
  }, [draft]);

  const sendText = async (text: string) => {
    stick.current = true;
    await rpc('rich.send', { id: session.id, text }).catch(() => setDraft(text));
  };

  const openTerminal = async (command: string | null) => {
    if (command === null) {
      const ok = await window.jarvis.confirm(
        'Open this conversation in a terminal?',
        'The rich view closes and Claude Code reopens the same conversation in its own screen. Nothing is deleted; "rich view" in the title bar brings you back.',
        'Open in terminal',
      );
      if (!ok) return;
    }
    await rpc('sessions.switchMode', { id: session.id, mode: 'terminal', command }).catch(() => {});
  };

  /** Run a slash command the way richCommands.ts says it runs. */
  const runCommand = async (text: string): Promise<void> => {
    const parsed = parseCommand(text)!;
    const cmd = { ...parsed, name: canonicalName(parsed.name) };
    const known = catalog.find((c) => c.name === cmd.name);
    const fail = (e: unknown) => setNote(e instanceof Error ? e.message.replace(/^Error: /, '') : String(e));
    const pickAndSend = (title: string, items: PickItem[], build: (it: PickItem) => string) =>
      setPicker({ title, items, onPick: (it) => { setPicker(null); void sendText(build(it)); } });
    switch (known?.kind === 'jarvis' ? cmd.name : '') {
      case 'plan':
        await rpc('rich.setPermissionMode', { id: session.id, mode: 'plan' }).catch(fail);
        setNote('Plan mode on: Claude reads and plans, and changes nothing until you approve');
        if (cmd.args) await sendText(cmd.args);
        return;
      case 'btw':
        if (!cmd.args) return setNote('Ask a side question: /btw <question>. It is answered from this conversation and not added to it.');
        stick.current = true;
        await rpc('rich.btw', { id: session.id, question: cmd.args }).catch(fail);
        return;
      case 'add-dir': {
        if (!cmd.args) return setNote('Usage: /add-dir <path>');
        const r = await rpc<{ ok: boolean; dirs: string[]; reason?: string }>('rich.addDir', { id: session.id, path: cmd.args }).catch((e) => ({ ok: false, dirs: [] as string[], reason: String(e) }));
        setNote(r.ok ? `Claude can now work in ${r.dirs.at(-1)!.replace(window.jarvis.homeDir, '~')}` : (r.reason ?? 'Could not add that directory'));
        return;
      }
      case 'cd': {
        if (!cmd.args) return setNote('Usage: /cd <path>');
        await rpc('rich.cd', { id: session.id, path: cmd.args }).then(() => setNote(`Moved to ${cmd.args}`)).catch(fail);
        return;
      }
      case 'branch':
        await rpc('rich.branch', { id: session.id, name: cmd.args || undefined })
          .then(() => setNote('Continuing in a new branch of the conversation. The original is in /resume.')).catch(fail);
        return;
      case 'fork':
        await rpc<SessionInfo>('rich.fork', { id: session.id, prompt: cmd.args || undefined })
          .then((s) => setNote(`Forked into "${s.name}" (in the sidebar). This one carries on.`)).catch(fail);
        return;
      case 'agent':
      case 'subtask': {
        const r = await rpc<{ agents: { name: string; description: string; model: string | null }[] }>('rich.agents', { id: session.id }).catch(() => ({ agents: [] }));
        setPicker(null);
        setRunAgent({ agents: r.agents, prompt: cmd.args, background: cmd.name === 'subtask' });
        return;
      }
      case 'diff':
        setState({ navOpen: true, navTab: 'changes' });
        return;
      case 'tasks': {
        const rows = [...taskStates.values()].reverse();
        setPicker({
          title: 'Background work: pick a running one to stop it', empty: 'Nothing is running in the background.',
          items: rows.map((t): PickItem => ({
            key: t.taskId, label: t.description || t.progress || t.taskId,
            badge: t.state === 'running' ? 'running' : t.state, detail: [t.agentType, t.tools != null ? `${t.tools} tool calls` : null, t.durationMs ? fmtDuration(t.durationMs) : null].filter(Boolean).join(' · '),
          })),
          onPick: async (it) => {
            setPicker(null);
            const t = taskStates.get(it.key);
            if (!t || t.state !== 'running') return;
            if (await window.jarvis.confirm(`Stop “${it.label.slice(0, 60)}”?`, 'The task is stopped; Claude is told it was stopped.', 'Stop it')) {
              await rpc('rich.stopTask', { id: session.id, taskId: t.taskId }).catch(fail);
            }
          },
        });
        return;
      }
      case 'mcp': {
        const [verb, ...rest] = cmd.args.split(/\s+/).filter(Boolean);
        const target = rest.join(' ');
        const call = (action: 'status' | 'reconnect' | 'toggle', name?: string, enabled?: boolean) =>
          rpc<{ servers: RichMcpServer[] }>('rich.mcp', { id: session.id, action, name, enabled });
        if (verb && /^(reconnect|enable|disable)$/.test(verb) && target) {
          const names = target === 'all' ? (await call('status').catch(() => ({ servers: [] as RichMcpServer[] }))).servers.map((x) => x.name) : [target];
          for (const n of names) await (verb === 'reconnect' ? call('reconnect', n) : call('toggle', n, verb === 'enable')).catch(fail);
          setNote(`${verb === 'reconnect' ? 'Reconnected' : verb === 'enable' ? 'Enabled' : 'Disabled'} ${target}`);
          return;
        }
        const show = async (servers: RichMcpServer[]) => setPicker({
          title: `MCP servers: ${servers.filter((x) => x.status === 'connected').length} connected of ${servers.length}. Pick one to reconnect or turn it on or off`,
          empty: 'No MCP servers configured.',
          items: servers.map((x): PickItem => ({
            key: x.name, label: x.name, badge: x.status,
            detail: [x.tools != null ? `${x.tools} tools` : null, x.scope, x.version && `v${x.version}`, x.error].filter(Boolean).join(' · '),
          })),
          onPick: (it) => {
            const srv = servers.find((x) => x.name === it.key)!;
            setPicker({
              title: srv.name,
              items: [
                { key: 'reconnect', label: 'Reconnect', detail: 'Drop the connection and connect again' },
                srv.status === 'disabled' ? { key: 'enable', label: 'Enable' } : { key: 'disable', label: 'Disable', detail: 'Its tools are no longer available to Claude' },
              ],
              onPick: async (act) => {
                setPicker({ title: srv.name, items: null });
                const r = await (act.key === 'reconnect' ? call('reconnect', srv.name) : call('toggle', srv.name, act.key === 'enable')).catch((e) => { fail(e); return null; });
                if (r) await show(r.servers);
                else setPicker(null);
              },
            });
          },
        });
        setPicker({ title: 'MCP servers', items: null });
        const r = await call('status').catch((e) => { fail(e); return null; });
        if (r) await show(r.servers);
        else setPicker(null);
        return;
      }
      case 'hooks': {
        setPicker({ title: 'Hooks', items: null });
        const r = await rpc<{ sources: { file: string; hooks: { event: string; matcher: string; command: string }[] }[] }>('rich.hooks', { id: session.id }).catch(() => ({ sources: [] }));
        setPicker({
          title: 'Hooks in your settings files (plugin hooks are not listed)', empty: 'No hooks in user, project or local settings.',
          items: r.sources.flatMap((src) => src.hooks.map((h, i): PickItem => ({ key: `${src.file}${i}`, label: `${h.event}  ${h.matcher}`, detail: `${h.command.replace(/\s+/g, ' ').slice(0, 140)}  ·  ${src.file}` }))),
        });
        return;
      }
      case 'agents': {
        setPicker({ title: 'Subagents', items: null });
        const r = await rpc<{ agents: { name: string; description: string; model: string | null }[] }>('rich.agents', { id: session.id }).catch(() => ({ agents: [] }));
        setPicker({
          title: 'Subagents Claude can use. Ask Claude to create or change them.', empty: 'No subagents.',
          items: r.agents.map((a): PickItem => ({ key: a.name, label: a.name, badge: a.model ?? undefined, detail: a.description.replace(/\s+/g, ' ').slice(0, 160) })),
        });
        return;
      }
      case 'skills': {
        const skills = catalog.filter((c) => c.kind === 'sdk');
        setPicker({
          title: 'Skills and commands from Claude Code. Pick one to put it in the composer.', empty: 'None.',
          items: skills.map((c): PickItem => ({ key: c.name, label: `/${c.name}`, detail: c.description.replace(/\s+/g, ' ').slice(0, 150) })),
          onPick: (it) => { setPicker(null); setDraft(`${it.label} `); requestAnimationFrame(() => input.current?.focus()); },
        });
        return;
      }
      case 'rename':
        await rpc('sessions.rename', { id: session.id, name: cmd.args }).catch(fail);
        setNote(cmd.args ? `Renamed to “${cmd.args}”` : 'The name follows Claude’s title again');
        return;
      case 'color': {
        const want = cmd.args.toLowerCase();
        if (want && want !== 'default' && !ACCENTS[want]) return setNote(`Colors: ${Object.keys(ACCENTS).join(', ')}, default`);
        const next = want === 'default' ? '' : want;
        setAccent(next);
        try { localStorage.setItem(`jarvis.rv.accent.${session.id}`, next); } catch { /* private window */ }
        setNote(next ? `Accent: ${next}` : 'Accent reset');
        return;
      }
      case 'theme':
        setPicker({
          title: 'Theme', items: THEMES.map((t): PickItem => ({ key: t.id, label: t.label, detail: t.kind, current: document.documentElement.dataset.theme === t.id })),
          onPick: (it) => { setPicker(null); setAppearance({ theme: it.key }); },
        });
        return;
      case 'focus':
        setDensity(density === 'focus' ? 'normal' : 'focus');
        setNote(density === 'focus' ? 'Thinking shown again' : 'Focus: thinking hidden');
        return;
      case 'keybindings': {
        const path = `${window.jarvis.homeDir}/.claude/keybindings.json`;
        const exists = await rpc<{ text?: string }>('files.read', { path }).then(() => true).catch(() => false);
        if (exists) openInViewer({ path, root: null, mode: 'file' });
        else setNote('No ~/.claude/keybindings.json yet. Ask Claude to create one (see /help for the format).');
        return;
      }
      case 'stop':
        await rpc('rich.interrupt', { id: session.id }).catch(fail);
        return;
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
      case 'context':
        await showContext();
        return;
      case 'rewind': {
        setPicker({ title: 'Rewind: go back to before one of your prompts', items: null });
        const pts = await rpc<{ uuid: string; text: string; ts: number | null; before: string | null }[]>('rich.rewindPoints', { id: session.id }).catch(() => []);
        const byKey = new Map(pts.map((p) => [p.uuid, p]));
        // The prompt you went back to returns to the composer, as in Claude Code, ready to edit and send again.
        const sid = session.id;
        const restore = (text: string) => {
          const cur = drafts.get(sid) ?? '';
          drafts.set(sid, cur.trim() ? `${text}\n\n${cur}` : text);
          // The view may have remounted while the session restarted; whichever instance is live picks it up.
          window.dispatchEvent(new CustomEvent('jarvis:draft', { detail: { id: sid } }));
          setTimeout(() => document.querySelector<HTMLTextAreaElement>('.rich-wrap:not([style*="none"]) .rv-input')?.focus(), 100);
        };
        setPicker({
          title: 'Rewind: go back to before one of your prompts (a new conversation; the original stays in /resume). The prompt goes back in the box.',
          empty: 'No earlier prompts found.',
          items: pts.map((p) => ({ key: p.uuid, label: p.text.replace(/\s+/g, ' ').slice(0, 110), detail: p.ts ? `${ago(p.ts)} ago` : '' })),
          onPick: (it) => {
            setPicker(null);
            const p = byKey.get(it.key);
            if (!p) return;
            // The very first prompt has nothing before it to fork at: going back to it is a fresh conversation.
            const going = p.before
              ? rpc('rich.rewind', { id: session.id, upToMessageId: p.before })
              : rpc('rich.send', { id: session.id, text: '/clear' });
            void going.then(() => restore(p.text)).catch(fail);
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
      case 'copy': {
        const n = Math.max(1, parseInt(cmd.args, 10) || 1);
        const pick = replies[replies.length - n];
        if (!pick) setNote('Nothing to copy yet');
        else {
          window.jarvis.copyText(pick);
          setNote(n === 1 ? "Copied Claude's last reply" : `Copied Claude's reply ${n} back`);
        }
        return;
      }
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
    if (known?.route.kind === 'link') {
      window.jarvis.openExternal(known.route.url);
      setNote(`Opened ${known.route.url.replace(/^https:\/\//, '')}`);
      return;
    }
    if (known?.route.kind === 'note') {
      setNote(known.route.text);
      return;
    }
    if (known?.kind === 'terminal') {
      // This swaps the session to Claude Code's own screen; ask first, and say what it does.
      const ok = await window.jarvis.confirm(
        `/${cmd.name} needs Claude Code's own screen`,
        'Jarvis will reopen this conversation in a terminal and type the command there. Nothing is deleted. The terminal resumes the same conversation, and "rich view" in the title bar brings you back.',
        'Open in terminal',
      );
      if (ok) await openTerminal(text.trim());
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
    // An alias of a command Claude Code runs is sent under the name it knows (/stats → /usage, /review → /code-review).
    await sendText(parsed.name !== cmd.name ? `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}` : text.trim());
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || !connected) return;
    setDraft('');
    if (text.startsWith('!')) {
      // Bash mode, as in Claude Code: run it here, show the output, and let it ride with the next message.
      const command = text.slice(1).trim();
      if (!command) return;
      stick.current = true;
      await rpc('rich.shell', { id: session.id, command }).catch((e) => { setDraft(text); setNote(e instanceof Error ? e.message.replace(/^Error: /, '') : String(e)); });
      return;
    }
    if (parseCommand(text)) await runCommand(text);
    else if (pendingShell.length) {
      const ids = pendingShell.map((r) => r.id);
      await sendText(`${shellContext(pendingShell)}\n\n${text}`);
      for (const id of ids) idSet(shellSent, session.id).add(id);
      bumpShell((n) => n + 1);
    } else await sendText(text);
  };

  const respond = (requestId: string, behavior: 'allow' | 'deny') =>
    void rpc('rich.respond', { id: session.id, requestId, behavior }).catch(() => {});
  const working = session.agentState?.phase === 'working';
  // Messages sent while Claude works wait in a tray (Jarvis holds them): their current text by uuid, which ones Claude
  // has been handed, which folded into the running turn, and whether you stopped Claude with some still held.
  const { queuedText, waiting, foldedMid, pausedQueue } = useMemo(() => {
    const queuedText = new Map<string, string>();
    const gone = new Set<string>();
    const sent = new Set<string>();
    const foldedMid = new Set<string>();
    let paused = false;
    for (const { event: e } of events) {
      if (e.kind === 'user' && e.queued && e.uuid) queuedText.set(e.uuid, e.text);
      else if (e.kind === 'user_read') for (const u of e.uuids) gone.add(u);
      else if (e.kind === 'queue') {
        if (e.action === 'edit' && e.uuid && e.text != null) queuedText.set(e.uuid, e.text);
        else if (e.action === 'remove' && e.uuid) gone.add(e.uuid);
        else if (e.action === 'release' && e.uuid) {
          sent.add(e.uuid);
          if (e.midTurn) foldedMid.add(e.uuid);
          paused = false;
        } else if (e.action === 'paused') paused = true;
      }
    }
    const waiting = [...queuedText.entries()].filter(([u]) => !gone.has(u)).map(([uuid, text]) => ({ uuid, text, sent: sent.has(uuid) }));
    return { queuedText, waiting, foldedMid, pausedQueue: paused && waiting.some((w) => !w.sent) };
  }, [events]);
  const workControls: WorkControls = {
    background: () => void background(),
    stop: () => void rpc('rich.interrupt', { id: session.id }).catch(() => {}),
  };

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
    if (!href) return;
    if (/^https?:\/\//.test(href)) {
      if (isLocalUrl(href)) openPreview(href);
      else window.jarvis.openExternal(href);
      return;
    }
    // A link to a file in the repo (docs, plans): open it in the viewer.
    const local = resolveLocalHref(href, session.cwd, window.jarvis.homeDir);
    if (local) openInViewer({ path: local.path, root: sessionRoot(session), mode: 'file', line: local.line });
  };

  const showContext = async () => {
    setPicker(null);
    setContext('loading');
    const r = await rpc<RichContext>('rich.context', { id: session.id }).catch(() => null);
    setContext(r);
  };

  // Clicking the ctx chip in the title bar opens the same panel.
  useEffect(() => {
    const open = (e: Event) => {
      if ((e as CustomEvent<{ id: string }>).detail.id === session.id) void showContext();
    };
    window.addEventListener('jarvis:context', open);
    return () => window.removeEventListener('jarvis:context', open);
  });

  /** Ctrl+B, as in Claude Code: move running tool calls to the background so Claude carries on. */
  const background = async () => {
    const r = await rpc<{ backgrounded: boolean }>('rich.background', { id: session.id }).catch(() => null);
    setNote(r?.backgrounded ? 'Moved the running task to the background' : 'Nothing running to background');
  };

  const agentCtx: AgentCtx = useMemo(() => ({
    sessionId: session.id, cwd: session.cwd, showThinking: density === 'detailed',
    kidsOf: (id) => structure.kids.get(id) ?? [], ends, taskOf: (id) => structure.tasks.get(id), reportOf: (id) => structure.reports.get(id),
  }), [session.id, session.cwd, density, structure, ends]);

  const rows = useMemo(() => {
  let lastStatus = '';
  return events.map(({ seq, ts, event: e, replay }) => {
    const key = `${seq}`;
    if (structure.hidden.has(seq)) return null;
    const sub = 'parentToolUseId' in e && e.parentToolUseId ? ' rv-sub' : '';
    switch (e.kind) {
      case 'user':
        // Sent while Claude was working: it waits in the queue tray, and shows here once Claude reads it.
        if (e.queued && e.uuid) return null;
        return <UserMessage key={key} text={e.text} replay={!!replay} />;
      case 'user_read':
        return e.uuids.filter((u) => queuedText.has(u)).map((u) => (
          <UserMessage key={`${key}-${u}`} text={queuedText.get(u)!} replay={false} tag={foldedMid.has(u) ? 'read mid-turn' : undefined} />
        ));
      case 'text':
        if (/^API Error:/.test(e.text)) return <div key={key} className="rv-apierr">{e.text.replace(/^API Error:\s*/, '')}</div>;
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
        if (e.tool === 'AskUserQuestion') return null; // the question card (or the "Asked:" line) stands in for it
        const end = ends.get(e.toolUseId);
        if (isAgentTool(e.tool)) return <AgentCard key={key} start={e} startTs={ts} end={end} ctx={agentCtx} />;
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
      case 'question_request': {
        const done = resolved.get(e.requestId);
        if (done || replay) {
          const ans = answersById.get(e.requestId);
          return (
            <div key={key} className="rv-asked">
              {e.questions.map((q, qi) => (
                <div key={qi}><span className="rv-asked-q">Asked: {q.question}</span>
                  <span className="rv-asked-a">{ans ? ` → ${[ans[q.question]].flat().join(', ')}` : done === 'deny' ? ' → skipped' : ''}</span></div>
              ))}
            </div>
          );
        }
        return (
          <QuestionCard key={key} questions={e.questions} disabled={!connected} from={agentLabel(e.agentId)}
            onAnswer={(answers) => void rpc('rich.answer', { id: session.id, requestId: e.requestId, answers }).catch(() => {})}
            onSkip={() => respond(e.requestId, 'deny')} />
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
            {e.agentId && <div className="rv-perm-from">asked by sub-agent: {agentLabel(e.agentId)}</div>}
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
            {e.stopped ? 'stopped' : e.ok ? 'done' : `failed: ${e.error ?? 'unknown error'}`}
            {e.durationMs != null && ` · ${(e.durationMs / 1000).toFixed(1)}s`}
            {cost && (plan
              ? <span title="What this turn would cost at API prices. On your plan it counts against your limits instead."> · ≈{cost} API equiv.</span>
              : ` · ${cost}`)}
          </div>
        );
      }
      case 'shell': {
        const run = shellRuns.get(e.id);
        if (!run) return null;
        const attach = idSet(shellSent, session.id).has(run.id) ? 'sent' : idSet(shellDismissed, session.id).has(run.id) ? 'none' : 'pending';
        return <ShellCard key={key} run={run} attach={attach}
          onStop={() => void rpc('rich.shellStop', { id: session.id, shellId: run.id }).catch(() => {})}
          onDismiss={() => { idSet(shellDismissed, session.id).add(run.id); bumpShell((n) => n + 1); }} />;
      }
      case 'local_output':
        return <pre key={key} className="rv-local-out">{e.text}</pre>;
      case 'btw': {
        const latest = structure.btw.get(e.id);
        return latest ? <BtwCard key={key} e={latest} /> : null;
      }
      case 'compact':
        return <CompactMarker key={key} e={e} />;
      case 'compact_summary':
        return <CompactSummary key={key} text={e.text} />;
      case 'compacting':
        return seq === structure.compactingSeq ? <Compacting key={key} /> : null;
      case 'task_notice': {
        const list = structure.notices.get(seq);
        return list ? <TaskNotices key={key} notices={list} /> : null;
      }
      case 'resumed':
        return <div key={key} className="rv-sep">{e.shown && e.shown < e.messages
          ? `resumed · showing the latest ${e.shown} of ${e.messages} messages (the rest are in the transcript)`
          : `resumed · ${e.messages} messages from the transcript`}</div>;
      case 'error':
        return <div key={key} className="rv-error">{e.message}</div>;
      case 'ended':
        return <div key={key} className="rv-sep">session ended: {e.reason}</div>;
      default:
        return null;
    }
  });
  // Typing in the composer must not re-render the whole conversation (thousands of rows in a long history).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, density, ends, resolved, answersById, thinking, structure, agentCtx, taskStates, shellRuns, shellTick, status, connected, session.cwd, session.id, queuedText, foldedMid]);
  return (
    <div className="rich-wrap" data-accent={accent || undefined}
      style={{ display: visible ? 'flex' : 'none', ...(accent && ACCENTS[accent] ? { ['--rv-accent' as string]: ACCENTS[accent] } : {}) }} onMouseDown={() => picker && setPicker(null)}
      onKeyDown={(e) => {
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b' && working) {
          e.preventDefault();
          void background();
        }
      }}>
      {session.rich?.outdated && (
        <div className="rv-outdated">
          <span>This session's helper process is from an older Jarvis, so newer features (questions, Ctrl+B, rewind, context) won't work in it.</span>
          <button className="btn" disabled={working} title={working ? 'Wait for the current turn to finish' : 'Restart the helper on the same conversation'}
            onClick={() => void rpc('rich.restart', { id: session.id }).catch(() => {})}>Restart session</button>
          <span className="muted">Your conversation carries over.</span>
        </div>
      )}
      <div className="rv-topbar">
        <div className="seg small rv-density" title="How much thinking to show (⌥⌘T)">
          {DENSITIES.map((d) => (
            <button key={d.id} className={`seg-btn ${density === d.id ? 'on' : ''}`} title={`${d.detail} (⌥⌘T cycles)`}
              onClick={() => setDensity(d.id)}>{d.label}</button>
          ))}
        </div>
      </div>
      <div className="rv-scroll" ref={box} onClick={onProseClick}
        onWheel={() => { userScroll.current = Date.now(); }} onPointerDown={() => { userScroll.current = Date.now(); }}
        onKeyDown={() => { userScroll.current = Date.now(); }}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!visible) return; // hiding a session fires a scroll to 0; that isn't you scrolling
          // Following the conversation ends only when you scroll away yourself. Layout changes (resizing the
          // window or a panel, content growing) move the scroll position too, and must not unpin the bottom.
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) stick.current = true;
          else if (Date.now() - userScroll.current < 600) stick.current = false;
          savedTop.current = el.scrollTop;
        }}>
        <div className="rv-column" key={look}>
          {!events.length && <div className="rv-empty">{connected ? 'Send a message to start. Type / for commands.' : 'Connecting to the session…'}</div>}
          {workRuns(rows, events, ends, session.cwd).map((x) => (x && typeof x === 'object' && 'tools' in x
            ? <WorkBlock key={`work-${x.key}`} run={x} startOpen={density === 'detailed'} actions={workControls} />
            : x))}
        </div>
      </div>
      <div className="rv-composer">
        {context && <ContextPanel data={context} onClose={() => { setContext(null); input.current?.focus(); }}
          onCompact={() => { setContext(null); void sendText('/compact'); }} />}
        {runAgent && <RunAgentPanel agents={runAgent.agents} initial={runAgent} onClose={() => { setRunAgent(null); input.current?.focus(); }}
          onRun={(o) => { setRunAgent(null); void sendText(agentRequest(o)); input.current?.focus(); }} />}
        {picker && <Picker {...picker} onClose={() => { setPicker(null); input.current?.focus(); }} />}
        {waiting.length > 0 && (
          <QueueTray items={waiting} paused={pausedQueue} onAction={(uuid, action, text) => {
            void rpc<{ ok: boolean; reason?: string }>('rich.queue', { id: session.id, uuid, action, text })
              .then((r) => { if (!r.ok) setNote(r.reason ?? 'Could not change that message'); })
              .catch(() => setNote('Could not reach the session'));
          }} />
        )}
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
          className={`rv-input${draft.startsWith('!') ? ' shell' : ''}`}
          rows={Math.min(10, Math.max(2, draft.split('\n').length))}
          placeholder={connected ? 'Message Claude (↵ send · ⇧↵ newline · / commands · ! shell · esc interrupt)' : 'Not connected'}
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
                if (c.hint.startsWith('<') && !/optional/i.test(c.hint) && c.kind !== 'jarvis' && !PICKER_COMMANDS.has(c.name)) setDraft(`/${c.name} `);
                else { setDraft(''); void runCommand(`/${c.name}`); }
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape' && draft.startsWith('!')) {
              e.preventDefault();
              setDraft('');
            } else if (e.key === 'Escape' && working) {
              e.preventDefault();
              void rpc('rich.interrupt', { id: session.id }).catch(() => {});
            }
          }}
        />
        <div className="rv-composer-bar">
          {draft.startsWith('!') && <span className="rv-shellmode">shell · runs in {session.cwd.replace(window.jarvis.homeDir, '~')} · ↵ run · esc cancel</span>}
          <span className="muted">{working ? `working${session.agentState?.tool ? `: ${session.agentState.tool}` : ''}` : connected ? 'ready' : 'disconnected'}</span>
          {note && <span className="rv-toast">{note}</span>}
          <span className="strip-spacer" />
          <button className="chip-btn" disabled={!connected} title="Run a sub-agent: pick its kind and give it a task" onClick={() => void runCommand('/agent')}>Agent</button>
          <button className="chip-btn" disabled={!connected || !draft.trim()} onClick={() => void submit()}>Send <kbd>↵</kbd></button>
        </div>
      </div>
    </div>
  );
}

