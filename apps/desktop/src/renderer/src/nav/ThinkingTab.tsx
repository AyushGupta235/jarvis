import { useEffect, useMemo, useState } from 'react';
import type { SessionInfo, ThinkingEntry, ThinkingList } from '@jarvis/protocol';
import { ago, rpc } from '../store';
import { Prose } from '../ProseView';
import { Empty } from './common';

/** Thoughts grouped under the prompt they were answering, newest prompt first. */
function group(entries: ThinkingEntry[]): { prompt: string | null; items: ThinkingEntry[] }[] {
  const out: { prompt: string | null; items: ThinkingEntry[] }[] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (last && last.prompt === e.prompt) last.items.push(e);
    else out.push({ prompt: e.prompt, items: [e] });
  }
  return out.reverse();
}

/**
 * The agent's thinking for this session, read from its Claude transcript, so it works for terminal and rich
 * sessions alike. Search filters across all of it.
 */
export function ThinkingTab({ s }: { s: SessionInfo }) {
  const [data, setData] = useState<ThinkingList | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const phase = s.agentState?.phase;

  useEffect(() => {
    let live = true;
    const load = () => void rpc<ThinkingList>('thinking.list', { id: s.id }).then((d) => live && setData(d)).catch(() => {});
    load();
    // Keep up while the agent works; thinking lands in the transcript as each turn streams.
    const t = setInterval(load, phase === 'working' ? 4000 : 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [s.id, s.agentSessionId, phase]);

  const needle = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const entries = (data?.entries ?? []).filter((e) => !needle || e.text.toLowerCase().includes(needle) || (e.prompt ?? '').toLowerCase().includes(needle));
    return group(entries);
  }, [data, needle]);

  if (s.external || (s.agent !== 'claude')) return <Empty>Thinking is shown for Claude sessions started in Jarvis.</Empty>;
  if (!data) return <Empty>Reading the transcript…</Empty>;
  const total = data.entries.length;
  return (
    <div className="nav-col">
      <div className="nav-head">
        <span>{total} thought{total === 1 ? '' : 's'}{data.omitted ? <span className="muted"> · {data.omitted} without text</span> : null}</span>
        <span className="strip-spacer" />
        <input className="pr-search" placeholder="Search thinking…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} />
      </div>
      <div className="nav-scroll think-list">
        {!total && (
          <Empty>
            {data.transcript ? 'No thinking with text in this conversation yet.' : 'No transcript yet. Thinking appears after the first reply.'}
            {data.omitted ? ' Earlier turns had their thinking omitted; new Jarvis sessions keep thinking summaries.' : ''}
          </Empty>
        )}
        {groups.map((g, gi) => (
          <section key={gi} className="think-group">
            {g.prompt && <div className="think-prompt" title={g.prompt}>› {g.prompt.replace(/\s+/g, ' ').slice(0, 220)}</div>}
            {g.items.map((e, i) => {
              const k = (e.ts ?? 0) * 1000 + i + gi;
              const isOpen = open.has(k) || !!needle;
              return (
                <div key={k} className={`think-item ${isOpen ? 'open' : ''}`}>
                  <div className="think-meta" onClick={() => setOpen((o) => {
                    const n = new Set(o);
                    if (n.has(k)) n.delete(k);
                    else n.add(k);
                    return n;
                  })}>
                    <span className="think-caret">{isOpen ? '▾' : '▸'}</span>
                    <span className="think-first">{e.text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').slice(0, 140)}</span>
                    <span className="muted">{e.ts ? ago(e.ts) : ''}</span>
                  </div>
                  {isOpen && <Prose text={e.text} className="think-body" />}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
