import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEntry, SessionInfo } from '@jarvis/protocol';
import { ago, fmtTokens, fmtUsd, loadActivity, openInViewer, sessionRoot, useStore } from '../store';
import { Empty } from './common';

type Filter = 'all' | 'tools' | 'errors' | 'chat';

const KIND_ICON: Record<string, string> = { prompt: '›', reply: '◆', tool: '⚙', notification: '!', subagent: '⑂', compact: '⇣', session: '○' };

function fileOf(e: ActivityEntry): string | null {
  if (!e.input || !e.tool || !['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) return null;
  try {
    const i = JSON.parse(e.input) as { file_path?: string; notebook_path?: string };
    return i.file_path ?? i.notebook_path ?? null;
  } catch {
    return null;
  }
}

function prettyInput(e: ActivityEntry): string {
  if (!e.input) return '';
  try {
    const i = JSON.parse(e.input) as Record<string, unknown>;
    if (e.tool === 'Bash' && typeof i.command === 'string') return i.command;
    return JSON.stringify(i, null, 2);
  } catch {
    return e.input;
  }
}

export function SessionStrip({ s }: { s: SessionInfo }) {
  const a = s.agentState;
  if (!a) return null;
  const pct = a.context?.usedPct ?? null;
  return (
    <div className="strip">
      <div className="strip-row">
        <span className={`phase-pill ${a.phase}`}>{a.phase.replace('_', ' ')}</span>
        {a.model && <span className="strip-model">{a.model}</span>}
        {a.subagentsRunning > 0 && <span className="strip-chip">⑂ {a.subagentsRunning} subagent{a.subagentsRunning > 1 ? 's' : ''}</span>}
        <span className="strip-spacer" />
        {a.costUsd != null && <span className="strip-num" title="Session cost (API-equivalent)">{fmtUsd(a.costUsd)}</span>}
        <span className="strip-num" title="Tool calls this session">⚙ {a.toolCalls}</span>
        {a.linesAdded != null && <span className="strip-num"><span className="plus">+{a.linesAdded}</span> <span className="minus">−{a.linesRemoved ?? 0}</span></span>}
      </div>
      {a.context && (
        <div className="ctx" title={`${fmtTokens(a.context.usedTokens)} of ${fmtTokens(a.context.windowTokens)} tokens`}>
          <div className="ctx-bar"><div className={`ctx-fill ${pct != null && pct > 80 ? 'hot' : pct != null && pct > 60 ? 'warm' : ''}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} /></div>
          <span className="ctx-label">context {pct != null ? `${Math.round(pct)}%` : '–'} · {fmtTokens(a.context.usedTokens)} / {fmtTokens(a.context.windowTokens)}</span>
        </div>
      )}
      {a.phase === 'needs_input' && a.message && <div className="strip-alert">{a.message}</div>}
      {a.phase === 'working' && a.tool && <div className="strip-tool">{a.tool}</div>}
    </div>
  );
}

export function ActivityTab({ s }: { s: SessionInfo }) {
  const entries = useStore((st) => st.activity[s.id]);
  const def = useStore((st) => st.snapshot?.agents.find((a) => a.id === s.agent));
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!s.external) void loadActivity(s.id);
  }, [s.id, s.external]);

  const shown = useMemo(() => (entries ?? []).filter((e) => {
    if (filter === 'tools') return e.kind === 'tool';
    if (filter === 'errors') return e.status === 'error';
    if (filter === 'chat') return e.kind === 'prompt' || e.kind === 'reply' || e.kind === 'notification';
    return true;
  }), [entries, filter]);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length]);

  if (!def?.integration) {
    return <Empty>Activity comes from an agent's own hooks or session log. It's available for Claude Code and Codex sessions; {def?.label ?? 'this agent'} runs as a plain terminal.</Empty>;
  }
  const root = sessionRoot(s);
  const errors = (entries ?? []).filter((e) => e.status === 'error').length;
  return (
    <div className="nav-col">
      <SessionStrip s={s} />
      <div className="nav-filters">
        {(['all', 'tools', 'errors', 'chat'] as Filter[]).map((f) => (
          <button key={f} className={`filter ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'chat' ? 'prompts & replies' : f}{f === 'errors' && errors ? ` ${errors}` : ''}
          </button>
        ))}
      </div>
      <div className="nav-scroll" ref={box} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {entries === undefined && <Empty>Loading…</Empty>}
        {entries && !shown.length && <Empty>{filter === 'all' ? 'Nothing yet. Tool calls, prompts and replies appear here as the agent works.' : 'Nothing matches.'}</Empty>}
        {shown.map((e) => {
          const isOpen = open.has(e.id);
          const file = fileOf(e);
          return (
            <div key={e.id} className={`act ${e.kind} ${e.status ?? ''} ${e.agentId ? 'sub' : ''}`}>
              <div className="act-row" onClick={() => setOpen((o) => {
                const n = new Set(o);
                if (n.has(e.id)) n.delete(e.id);
                else n.add(e.id);
                return n;
              })}>
                <span className="act-icon">{e.status === 'running' ? <i className="spin" /> : KIND_ICON[e.kind]}</span>
                {e.tool && <span className="act-tool">{e.tool.startsWith('mcp__') ? e.tool.split('__').slice(1).join('·').replace(/^claude_ai_/, '') : e.tool}</span>}
                {e.agentType && <span className="act-agent">{e.agentType}</span>}
                <span className="act-sum">{e.summary}</span>
                <span className="act-meta">{e.durationMs != null ? `${e.durationMs < 1000 ? `${e.durationMs}ms` : `${(e.durationMs / 1000).toFixed(1)}s`}` : ago(e.ts)}</span>
              </div>
              {isOpen && (
                <div className="act-detail">
                  {file && <button className="chip-btn" onClick={() => openInViewer({ path: file, root, mode: 'file' })}>Open {file.split('/').pop()}</button>}
                  {e.kind === 'tool' && e.input && <><div className="act-label">input</div><pre>{prettyInput(e)}</pre></>}
                  {e.output && <><div className="act-label">{e.kind === 'tool' ? 'output' : e.kind}</div>{e.tool && ['Edit', 'MultiEdit', 'Write'].includes(e.tool)
                    ? <pre className="as-diff">{e.output.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l || ' '}</div>)}</pre>
                    : <pre>{e.output}</pre>}</>}
                  <button className="chip-btn ghost" onClick={() => window.jarvis.copyText(`${prettyInput(e)}\n\n${e.output ?? ''}`)}>Copy</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
