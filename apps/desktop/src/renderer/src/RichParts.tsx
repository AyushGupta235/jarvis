import { useEffect, useMemo, useState } from 'react';
import type { RichEnvelope, RichEvent } from '@jarvis/protocol';
import { Prose } from './ProseView';
import { rpc } from './store';
import { shortenPaths, toolLine } from './toolText';

type Ev<K extends RichEvent['kind']> = Extract<RichEvent, { kind: K }>;

export const fmtTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const LONG_LINES = 10;
const LONG_CHARS = 900;

/**
 * What you sent. A long message (a pasted log, a plan, a diff) folds to its first lines, with the size on the
 * toggle, so it doesn't push the conversation off the screen. It opens in place.
 */
export function UserMessage({ text, replay, tag }: { text: string; replay: boolean; tag?: string }) {
  const lines = text.split('\n').length;
  const long = lines > LONG_LINES || text.length > LONG_CHARS;
  const [open, setOpen] = useState(false);
  return (
    <div className={`rv-user${replay ? ' replay' : ''}${long && !open ? ' folded' : ''}`}>
      <span className="rv-caret">›</span>
      <div className="rv-user-body">{text}</div>
      {tag && <span className="rv-user-tag">{tag}</span>}
      {long && (
        <button className="rv-user-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show all · ${lines} lines · ${text.length >= 10_000 ? `${Math.round(text.length / 1000)}k` : text.length} chars`}
        </button>
      )}
    </div>
  );
}

/** Two or three words for a notice: "Monitor", "done", "failed", "stopped". */
function noticeTitle(n: Ev<'task_notice'>): { label: string; title: string } {
  const m = /^Monitor event: "?(.*?)"?$/s.exec(n.summary);
  if (m) return { label: 'Monitor', title: m[1]! };
  return { label: n.status === 'completed' ? 'done' : n.status === 'event' ? 'update' : n.status, title: n.summary };
}

const firstLine = (t: string) => t.split('\n').find((l) => l.trim())?.trim() ?? '';

/**
 * A background task reporting in (a command finished or stopped, a monitor's events, a sub-agent done). Claude
 * Code delivers these as prompts made of XML tags; here each is a line you can read, with the detail folded.
 * A run of reports from one task stacks under one header.
 */
export function TaskNotices({ notices }: { notices: Ev<'task_notice'>[] }) {
  const [open, setOpen] = useState(false);
  const last = notices.at(-1)!;
  const { label, title } = noticeTitle(last);
  const failed = notices.some((n) => n.status === 'failed');
  const stopped = notices.some((n) => n.status === 'stopped');
  const done = notices.some((n) => n.status === 'completed');
  const state = failed ? 'err' : stopped ? 'stop' : done ? 'ok' : 'live';
  const detail = notices.filter((n) => n.event);
  const preview = detail.length ? firstLine(detail.at(-1)!.event!) : '';
  return (
    <div className={`rv-notice ${state}`}>
      <div className="rv-notice-head" onClick={() => detail.length && setOpen((o) => !o)} style={{ cursor: detail.length ? 'pointer' : 'default' }}>
        <span className="rv-dot">{failed ? '✗' : stopped ? '■' : done ? '✓' : '◇'}</span>
        <span className="rv-notice-label">{label}</span>
        <span className="rv-notice-title">{title}</span>
        {notices.length > 1 && <span className="rv-notice-count">{notices.length} updates</span>}
        {!open && preview && <span className="rv-notice-preview">{preview}</span>}
        {detail.length > 0 && <span className="rv-notice-caret">{open ? '▾' : '▸'}</span>}
      </div>
      {open && (
        <div className="rv-notice-body">
          {detail.map((n, i) => <pre key={i} className="rv-io">{n.event}</pre>)}
        </div>
      )}
    </div>
  );
}

/** The conversation was compacted: a marker with what it did, and the summary Claude carries forward, folded. */
export function CompactMarker({ e }: { e: Ev<'compact'> }) {
  if (e.error) return <div className="rv-error">Compaction failed: {e.error}</div>;
  const bits = [
    e.trigger === 'auto' ? 'automatic' : e.trigger === 'manual' ? '/compact' : null,
    e.preTokens ? `${fmtTokens(e.preTokens)}${e.postTokens ? ` → ${fmtTokens(e.postTokens)}` : ''} tokens` : null,
    e.durationMs ? fmtDuration(e.durationMs) : null,
  ].filter(Boolean);
  return (
    <div className="rv-compact">
      <span className="rv-compact-rule" />
      <span className="rv-compact-text">Conversation compacted{bits.length ? ` · ${bits.join(' · ')}` : ''}</span>
      <span className="rv-compact-rule" />
    </div>
  );
}

export function CompactSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const body = text.replace(/^This session is being continued[^\n]*\n+/, '').replace(/^Summary:\s*/, '');
  return (
    <div className="rv-compact-summary">
      <button className="rv-compact-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} What Claude carries forward <span className="muted">· {Math.round(body.length / 100) / 10}k chars</span>
      </button>
      {open && <Prose text={body} className="rv-text rv-compact-body" />}
    </div>
  );
}

export function Compacting() {
  return <div className="rv-compacting"><span className="rv-dot running">◌</span> Compacting the conversation… Claude is summarising it to free context.</div>;
}

/** The latest progress report per sub-agent (or background command), keyed by the tool call that started it. */
export function taskByTool(events: RichEnvelope[]): Map<string, Ev<'task'>> {
  const out = new Map<string, Ev<'task'>>();
  for (const { event: e } of events) {
    if (e.kind !== 'task' || !e.toolUseId) continue;
    const prev = out.get(e.toolUseId);
    out.set(e.toolUseId, prev ? {
      ...prev, ...e, description: e.description ?? prev.description, agentType: e.agentType ?? prev.agentType, tools: e.tools ?? prev.tools,
      tokens: e.tokens ?? prev.tokens, durationMs: e.durationMs ?? prev.durationMs, lastTool: e.lastTool ?? prev.lastTool,
      progress: e.progress ?? prev.progress, background: e.background || prev.background, model: e.model ?? prev.model,
    } : e);
  }
  return out;
}

export const isAgentTool = (t: string) => t === 'Agent' || t === 'Task';

const ASYNC_LAUNCH = /^Async agent launched successfully/;
/** What the tool call itself returns when the agent's answer is delivered some other way. */
const HANDED_OFF = /^(Async agent launched successfully|This agent's report was delivered to you as a message)/;

/** Everything a card needs to know about the conversation around it (and to draw the agents nested inside it). */
export interface AgentCtx {
  sessionId: string;
  cwd: string;
  showThinking: boolean;
  kidsOf: (toolUseId: string) => RichEnvelope[];
  ends: Map<string, Ev<'tool_end'>>;
  taskOf: (toolUseId: string) => Ev<'task'> | undefined;
  reportOf: (toolUseId: string) => Ev<'task_notice'> | undefined;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const shortModel = (m: string) => m.replace(/^claude-/, '');
const isHandback = (k: RichEvent) => k.kind === 'tool_start' && k.tool === 'SubagentHandback';

/**
 * A sub-agent: one card for the whole delegation instead of its steps mixed into the conversation. The header
 * says what it was asked, how far along it is (with a clock that runs while it works) and what it has used;
 * it opens to the prompt, each step it took (an agent it started is a card inside it), and its answer. A card
 * for an agent that finished before a restart loads its steps from the agent's own transcript when opened.
 */
export function AgentCard({ start, startTs, end, ctx }: {
  start: Ev<'tool_start'>;
  startTs: number;
  end: Ev<'tool_end'> | undefined;
  ctx: AgentCtx;
}) {
  const task = ctx.taskOf(start.toolUseId);
  const report = ctx.reportOf(start.toolUseId);
  const input = (start.input ?? {}) as { description?: string; prompt?: string; subagent_type?: string };
  const launched = !!end && ASYNC_LAUNCH.test(end.output.trim());
  const handedOff = !!end && HANDED_OFF.test(end.output.trim());
  const finished = report
    ? report.status === 'completed' ? 'ok' : report.status === 'failed' ? 'error' : 'stopped'
    : task && task.state !== 'running' ? (task.state === 'done' ? 'ok' : task.state === 'failed' ? 'error' : 'stopped') : null;
  // Stopping an agent ends its tool call with an interruption error; that is you stopping it, not it failing.
  const interrupted = !!end?.isError && /^\[?Request interrupted by user/.test(end.output.trim());
  const state = finished === 'stopped' || interrupted ? 'stopped'
    : launched ? (finished ?? 'running') : !end ? (task?.state === 'failed' ? 'error' : finished ?? 'running') : end.isError ? 'error' : 'ok';
  const [open, setOpen] = useState(state === 'error');
  const now = useNow(state === 'running');

  // Its steps: live ones arrive as events; for a finished agent that has none (after a restart), fetch on opening.
  const liveKids = ctx.kidsOf(start.toolUseId);
  const [fetched, setFetched] = useState<RichEvent[] | null>(null);
  useEffect(() => {
    if (!open || fetched || liveKids.length || state === 'running' || !task?.taskId) return;
    let alive = true;
    void rpc<{ events: RichEvent[] }>('rich.agentSteps', { id: ctx.sessionId, agentId: task.taskId, toolUseId: start.toolUseId })
      .then((r) => alive && setFetched(r.events)).catch(() => alive && setFetched([]));
    return () => { alive = false; };
  }, [open, fetched, liveKids.length, state, task?.taskId]);
  const kidsAll: RichEnvelope[] = liveKids.length ? liveKids : (fetched ?? []).map((event, i) => ({ seq: i, ts: 0, event }));
  const inner: AgentCtx = useMemo(() => {
    if (liveKids.length || !fetched) return ctx;
    const ends = new Map(ctx.ends);
    const tasks = new Map<string, Ev<'task'>>();
    for (const e of fetched) {
      if (e.kind === 'tool_end') ends.set(e.toolUseId, e);
      else if (e.kind === 'task' && e.toolUseId) tasks.set(e.toolUseId, e);
    }
    return { ...ctx, ends, taskOf: (id) => tasks.get(id) ?? ctx.taskOf(id) };
  }, [ctx, fetched, liveKids.length]);

  const handback = [...kidsAll].reverse().map((k) => k.event).find(isHandback) as Ev<'tool_start'> | undefined;
  const lastText = [...kidsAll].reverse().map((k) => k.event).find((k): k is Ev<'text'> => k.kind === 'text')?.text.trim() ?? '';
  const lastSaid = String((handback?.input as { message?: unknown } | undefined)?.message ?? '').trim() || lastText;
  const kids = kidsAll.filter((k) => !isHandback(k.event));
  const steps = kids.filter((k) => k.event.kind === 'tool_start');
  const latest = [...steps].reverse().map((k) => k.event as Ev<'tool_start'>).find((t) => !inner.ends.has(t.toolUseId)) ?? (steps.at(-1)?.event as Ev<'tool_start'> | undefined);
  // The SDK counts the hand-back call as a tool call; the steps shown don't.
  const toolCount = steps.length || Math.max(0, (task?.tools ?? 0) - (task && task.state !== 'running' ? 1 : 0));
  const elapsed = state === 'running' ? Math.max(0, now - startTs) : task?.durationMs ?? null;
  const stats = [
    task?.model ? shortModel(task.model) : null,
    toolCount ? `${toolCount} tool call${toolCount === 1 ? '' : 's'}` : null,
    task?.tokens ? `${fmtTokens(task.tokens)} tokens` : null,
    elapsed ? fmtDuration(elapsed) : null,
  ].filter(Boolean).join(' · ');
  const kind = input.subagent_type || task?.agentType || 'Agent';
  const raw = interrupted ? '' : report?.event?.trim() || (handedOff ? (launched && !finished ? '' : lastSaid) : (end?.output?.trim() ?? ''));
  const result = useMemo(() => shortenPaths(raw, ctx.cwd, window.jarvis.homeDir), [raw, ctx.cwd]);
  return (
    <div className={`rv-agent ${state}${open ? ' open' : ''}`}>
      <div className="rv-agent-head" onClick={() => setOpen((o) => !o)}>
        <span className="rv-dot">{state === 'running' ? '◌' : state === 'error' ? '✗' : '⏺'}</span>
        <span className="rv-agent-kind">{kind}</span>
        <span className="rv-agent-desc">{input.description || firstLine(input.prompt ?? '')}</span>
        {(launched || task?.background) && state === 'running' && <span className="rv-agent-bg">background</span>}
        {state === 'stopped' && <span className="rv-agent-bg">stopped</span>}
        {stats && <span className="rv-agent-stats">{stats}</span>}
        {state === 'running' && task?.taskId && (
          <button className="chip-btn rv-agent-stop" title="Stop this agent (the rest of the turn carries on)"
            onClick={(e) => { e.stopPropagation(); void rpc('rich.stopTask', { id: ctx.sessionId, taskId: task.taskId }).catch(() => {}); }}>Stop</button>
        )}
        <span className="rv-notice-caret">{open ? '▾' : '▸'}</span>
      </div>
      {!open && state === 'running' && (task?.progress || latest) && (
        <div className="rv-agent-live">{task?.progress || `${latest!.tool} ${toolLine(latest!.tool, latest!.input, ctx.cwd)}`}</div>
      )}
      {!open && state !== 'running' && result && <div className="rv-agent-preview">{firstLine(result).slice(0, 200)}</div>}
      {!open && state === 'stopped' && !result && <div className="rv-agent-preview">Stopped before it reported back.</div>}
      {open && (
        <div className="rv-agent-body">
          {input.prompt && (
            <details className="rv-agent-prompt">
              <summary>Prompt</summary>
              <pre className="rv-io">{input.prompt}</pre>
            </details>
          )}
          {open && !kids.length && !liveKids.length && state !== 'running' && fetched === null && task?.taskId && <div className="rv-agent-live">Loading its steps…</div>}
          {kids.length > 0 && (
            <div className="rv-agent-steps">
              {kids.map(({ seq, ts, event: k }) => {
                if (k.kind === 'tool_start') {
                  if (isAgentTool(k.tool)) return <AgentCard key={`${seq}-${k.toolUseId}`} start={k} startTs={ts} end={inner.ends.get(k.toolUseId)} ctx={inner} />;
                  const e = inner.ends.get(k.toolUseId);
                  const st = !e ? 'running' : e.isError ? 'error' : 'ok';
                  return (
                    <details key={`${seq}-${k.toolUseId}`} className={`rv-tool compact ${st}`} open={st === 'error'}>
                      <summary>
                        <span className="rv-dot">{st === 'running' ? '◌' : st === 'error' ? '✗' : '⏺'}</span>
                        <span className="rv-tool-name">{k.tool}</span>
                        <span className="rv-tool-arg">{toolLine(k.tool, k.input, ctx.cwd)}</span>
                      </summary>
                      <pre className="rv-io">{JSON.stringify(k.input, null, 2)}</pre>
                      {e && <pre className={`rv-io out${e.isError ? ' err' : ''}`}>{e.output || '(no output)'}</pre>}
                    </details>
                  );
                }
                if (k.kind === 'text') return <Prose key={seq} text={k.text} className="rv-text rv-agent-text" />;
                if (k.kind === 'thinking' && ctx.showThinking) return <div key={seq} className="rv-think-open"><span className="rv-think-tag">Thinking</span><Prose text={k.text} className="rv-think-para" /></div>;
                return null;
              })}
            </div>
          )}
          {result && (
            <div className="rv-agent-result">
              <div className="rv-agent-result-tag">{state === 'error' ? 'Error' : state === 'stopped' ? 'Stopped' : 'Result'}</div>
              <Prose text={result} className="rv-text" />
            </div>
          )}
          {!result && state === 'running' && <div className="rv-agent-live">{steps.length ? 'Working…' : launched ? 'Running in the background. Its answer shows here when it reports back.' : 'Starting…'}</div>}
        </div>
      )}
    </div>
  );
}

/** A /btw side question and its answer: shown in the flow where it was asked, but not part of the conversation. */
export function BtwCard({ e }: { e: Ev<'btw'> }) {
  return (
    <div className={`rv-btw${e.error ? ' err' : ''}`}>
      <div className="rv-btw-head">
        <span className="rv-btw-tag">/btw</span>
        <span className="rv-btw-q">{e.question}</span>
        <span className="rv-btw-note">side question · not added to the conversation</span>
      </div>
      {e.error ? <div className="rv-btw-a err">{e.error}</div>
        : e.answer == null ? <div className="rv-btw-a muted"><span className="rv-dot running">◌</span> Thinking…</div>
        : <Prose text={e.answer} className="rv-text rv-btw-a" />}
    </div>
  );
}

export interface RunAgentOptions {
  type: string;
  description: string;
  prompt: string;
  background: boolean;
}

/**
 * What Claude is told to run a sub-agent you chose. The SDK has no call that spawns one directly, so Claude is
 * asked to make exactly that Agent call, with your prompt untouched.
 */
export function agentRequest(o: RunAgentOptions): string {
  const desc = (o.description.trim() || o.prompt.trim().split(/\s+/).slice(0, 5).join(' ')).replace(/"/g, "'");
  return [
    `Use the Agent tool right now, exactly once, with subagent_type "${o.type}", description "${desc}", run_in_background ${o.background} and the prompt below, word for word.`,
    'Do not do the work yourself and do not change the prompt.',
    o.background ? 'It runs in the background: carry on with whatever else I ask, and show me its report when it arrives.' : 'When it finishes, show me its report.',
    '',
    'Prompt:',
    o.prompt.trim(),
  ].join('\n');
}

/** Run a sub-agent yourself: pick the kind, say what it should do, choose whether it runs in the background. */
export function RunAgentPanel({ agents, initial, onRun, onClose }: {
  agents: { name: string; description: string; model: string | null }[];
  initial: { prompt: string; background: boolean };
  onRun: (o: RunAgentOptions) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState(agents.find((a) => a.name === 'general-purpose')?.name ?? agents[0]?.name ?? 'general-purpose');
  const [prompt, setPrompt] = useState(initial.prompt);
  const [description, setDescription] = useState('');
  const [background, setBackground] = useState(initial.background);
  const picked = agents.find((a) => a.name === type);
  const run = () => prompt.trim() && onRun({ type, description, prompt, background });
  return (
    <div className="rv-runagent" onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
      }}>
      <div className="rv-runagent-head"><span>Run a sub-agent</span><button className="chip-btn" onClick={onClose}>esc</button></div>
      <label className="rv-runagent-row">
        <span>Agent</span>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {(agents.length ? agents : [{ name: 'general-purpose', description: '', model: null }]).map((a) => <option key={a.name} value={a.name}>{a.name}{a.model ? ` (${a.model})` : ''}</option>)}
        </select>
      </label>
      {picked?.description && <div className="rv-runagent-hint">{picked.description.replace(/\s+/g, ' ').slice(0, 220)}</div>}
      <textarea className="rv-runagent-prompt" autoFocus rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should it do? It starts with nothing but this prompt, so say where to look and what to report." />
      <label className="rv-runagent-row">
        <span>Label</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short name for the card (optional)" />
      </label>
      <label className="rv-runagent-check"><input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} /> Run in the background (you can carry on; its report arrives when it is done)</label>
      <div className="rv-runagent-actions">
        <button className="btn primary" disabled={!prompt.trim()} onClick={run}>Run agent <kbd>⌘↵</kbd></button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
