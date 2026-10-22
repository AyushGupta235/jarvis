import { useState } from 'react';
import type { RichEnvelope, RichEvent } from '@jarvis/protocol';
import { Prose } from './ProseView';
import { toolLine } from './toolText';

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
      progress: e.progress ?? prev.progress, background: e.background || prev.background,
    } : e);
  }
  return out;
}

export const isAgentTool = (t: string) => t === 'Agent' || t === 'Task';

/**
 * A sub-agent: one card for the whole delegation instead of its steps mixed into the conversation. The header
 * says what it was asked, how far along it is and what it has used; it opens to the prompt, each step it took,
 * and its answer.
 */
const ASYNC_LAUNCH = /^Async agent launched successfully/;
/** What the tool call itself returns when the agent's answer is delivered some other way. */
const HANDED_OFF = /^(Async agent launched successfully|This agent's report was delivered to you as a message)/;

export function AgentCard({ start, end, kids, ends, task, report, cwd, showThinking }: {
  start: Ev<'tool_start'>;
  end: Ev<'tool_end'> | undefined;
  kids: RichEnvelope[];
  ends: Map<string, Ev<'tool_end'>>;
  task: Ev<'task'> | undefined;
  /** The task's own report (a background agent answers later, as a notification). */
  report: Ev<'task_notice'> | undefined;
  cwd: string;
  showThinking: boolean;
}) {
  const input = (start.input ?? {}) as { description?: string; prompt?: string; subagent_type?: string };
  // A background agent's tool call returns at once with a launch note; the real answer arrives as its report.
  const launched = !!end && ASYNC_LAUNCH.test(end.output.trim());
  const handedOff = !!end && HANDED_OFF.test(end.output.trim());
  // An agent answers either with a last message or by handing back through its SubagentHandback tool.
  const isHandback = (k: RichEvent) => k.kind === 'tool_start' && k.tool === 'SubagentHandback';
  const handback = [...kids].reverse().map((k) => k.event).find(isHandback) as Ev<'tool_start'> | undefined;
  const lastText = [...kids].reverse().map((k) => k.event).find((k): k is Ev<'text'> => k.kind === 'text')?.text.trim() ?? '';
  const lastSaid = String((handback?.input as { message?: unknown } | undefined)?.message ?? '').trim() || lastText;
  kids = kids.filter((k) => !isHandback(k.event));
  const finished = report ? report.status === 'completed' ? 'ok' : report.status === 'failed' ? 'error' : 'stopped' : task && task.state !== 'running' ? (task.state === 'done' ? 'ok' : task.state === 'failed' ? 'error' : 'stopped') : null;
  const state = launched ? (finished ?? 'running') : !end ? (task?.state === 'failed' ? 'error' : 'running') : end.isError ? 'error' : 'ok';
  const [open, setOpen] = useState(state === 'error');
  const steps = kids.filter((k) => k.event.kind === 'tool_start');
  const counts = new Map<string, number>();
  for (const k of steps) if (k.event.kind === 'tool_start') counts.set(k.event.tool, (counts.get(k.event.tool) ?? 0) + 1);
  const toolCount = task?.tools ?? steps.length;
  const latest = [...steps].reverse().map((k) => k.event as Ev<'tool_start'>).find((t) => !ends.has(t.toolUseId)) ?? (steps.at(-1)?.event as Ev<'tool_start'> | undefined);
  const stats = [
    toolCount ? `${toolCount} tool call${toolCount === 1 ? '' : 's'}` : null,
    task?.tokens ? `${fmtTokens(task.tokens)} tokens` : null,
    task?.durationMs ? fmtDuration(task.durationMs) : null,
  ].filter(Boolean).join(' · ');
  const kind = input.subagent_type || task?.agentType || 'Agent';
  // The answer: the agent's report if it came as one, else what it said last, else what the tool call returned.
  const result = report?.event?.trim() || (handedOff ? (launched && !finished ? '' : lastSaid) : (end?.output?.trim() ?? ''));
  return (
    <div className={`rv-agent ${state}${open ? ' open' : ''}`}>
      <div className="rv-agent-head" onClick={() => setOpen((o) => !o)}>
        <span className="rv-dot">{state === 'running' ? '◌' : state === 'error' ? '✗' : '⏺'}</span>
        <span className="rv-agent-kind">{kind}</span>
        <span className="rv-agent-desc">{input.description || firstLine(input.prompt ?? '')}</span>
        {(launched || task?.background) && state === 'running' && <span className="rv-agent-bg">background</span>}
        {state === 'stopped' && <span className="rv-agent-bg">stopped</span>}
        {stats && <span className="rv-agent-stats">{stats}</span>}
        <span className="rv-notice-caret">{open ? '▾' : '▸'}</span>
      </div>
      {!open && state === 'running' && (task?.progress || latest) && (
        <div className="rv-agent-live">{task?.progress || `${latest!.tool} ${toolLine(latest!.tool, latest!.input, cwd)}`}</div>
      )}
      {!open && state !== 'running' && result && <div className="rv-agent-preview">{firstLine(result).slice(0, 200)}</div>}
      {open && (
        <div className="rv-agent-body">
          {input.prompt && (
            <details className="rv-agent-prompt">
              <summary>Prompt</summary>
              <pre className="rv-io">{input.prompt}</pre>
            </details>
          )}
          {counts.size > 0 && (
            <div className="rv-agent-steps">
              {kids.map(({ seq, event: k }) => {
                if (k.kind === 'tool_start') {
                  const e = ends.get(k.toolUseId);
                  const st = !e ? 'running' : e.isError ? 'error' : 'ok';
                  return (
                    <details key={seq} className={`rv-tool compact ${st}`} open={st === 'error'}>
                      <summary>
                        <span className="rv-dot">{st === 'running' ? '◌' : st === 'error' ? '✗' : '⏺'}</span>
                        <span className="rv-tool-name">{k.tool}</span>
                        <span className="rv-tool-arg">{toolLine(k.tool, k.input, cwd)}</span>
                      </summary>
                      <pre className="rv-io">{JSON.stringify(k.input, null, 2)}</pre>
                      {e && <pre className={`rv-io out${e.isError ? ' err' : ''}`}>{e.output || '(no output)'}</pre>}
                    </details>
                  );
                }
                if (k.kind === 'text') return <Prose key={seq} text={k.text} className="rv-text rv-agent-text" />;
                if (k.kind === 'thinking' && showThinking) return <div key={seq} className="rv-think-open"><span className="rv-think-tag">Thinking</span><Prose text={k.text} className="rv-think-para" /></div>;
                return null;
              })}
            </div>
          )}
          {result && (
            <div className="rv-agent-result">
              <div className="rv-agent-result-tag">{state === 'error' ? 'Error' : 'Result'}</div>
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
