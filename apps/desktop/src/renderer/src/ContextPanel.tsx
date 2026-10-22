import { useState } from 'react';
import type { RichContext } from '@jarvis/protocol';

const fmt = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n));
const pct = (n: number, of: number): string => `${((n / of) * 100).toFixed(1)}%`;

/** Colour roles per category, from the theme (so it follows View → Theme). */
const SWATCH: Record<string, string> = {
  messages: 'var(--foam)', mcp_tools: 'var(--gold)', system_tools: 'var(--pine)', system_prompt: 'var(--iris)',
  skills: 'var(--rose)', custom_agents: 'var(--love)', memory_files: 'var(--subtle)', mcp_instructions: 'var(--muted)',
};

/** A collapsible group of itemized rows (MCP servers, memory files, agents, skills, message parts). */
function Group({ title, count, total, rows }: { title: string; count: number; total: number; rows: { label: string; detail?: string; tokens: number }[] }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <div className="cx-group">
      <div className="cx-group-head" onClick={() => setOpen((o) => !o)}>
        <span className="cx-caret">{open ? '▾' : '▸'}</span><span>{title}</span><span className="cx-count">{count}</span><span className="strip-spacer" /><span className="cx-num">{fmt(total)}</span>
      </div>
      {open && rows.map((r, i) => (
        <div key={i} className="cx-item" title={r.detail ?? r.label}>
          <span className="cx-item-label">{r.label}</span>{r.detail && <span className="cx-item-detail">{r.detail}</span>}<span className="cx-num">{fmt(r.tokens)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The context window at a glance: used of total, a stacked bar, a row per category with tokens and share, the
 * deferred tools, what the messages are made of, and the biggest items in each group. Compact sends /compact.
 */
export function ContextPanel({ data, onCompact, onClose }: { data: RichContext | 'loading'; onCompact: () => void; onClose: () => void }) {
  if (data === 'loading') {
    return <div className="rv-picker cx"><div className="rv-picker-head"><span className="rv-picker-title">Context</span><span className="strip-spacer" /><button className="chip-btn ghost" onClick={onClose}>esc</button></div><div className="rv-pick muted">Counting tokens…</div></div>;
  }
  const max = data.maxTokens;
  const used = data.categories.filter((c) => c.kind === 'used');
  const deferred = data.categories.filter((c) => c.kind === 'deferred');
  const buffer = data.categories.find((c) => c.kind === 'buffer');
  const free = data.categories.find((c) => c.kind === 'free');
  const until = data.autoCompactAt != null ? Math.max(0, data.autoCompactAt - data.totalTokens) : free ? free.tokens : null;
  const tone = data.percentage > 80 ? 'hot' : data.percentage > 60 ? 'warm' : '';
  const byId = (id: string) => data.categories.find((c) => c.id === id)?.tokens ?? 0;
  return (
    <div className="rv-picker cx" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="rv-picker-head"><span className="rv-picker-title">Context · {data.model}</span><span className="strip-spacer" /><button className="chip-btn ghost" onClick={onClose}>esc</button></div>
      <div className="cx-body">
        <div className="cx-top"><span className={`cx-big ${tone}`}>{Math.round(data.percentage)}% used</span><span className="cx-total">{fmt(data.totalTokens)} / {fmt(max)}</span></div>
        <div className="cx-bar" title={`${data.totalTokens.toLocaleString()} of ${max.toLocaleString()} tokens`}>
          {used.map((c) => <i key={c.id} style={{ width: `${(c.tokens / max) * 100}%`, background: SWATCH[c.id] ?? 'var(--muted)' }} title={`${c.name}: ${fmt(c.tokens)}`} />)}
          {buffer && <i className="buf" style={{ width: `${(buffer.tokens / max) * 100}%` }} title={`${buffer.name}: ${fmt(buffer.tokens)}`} />}
        </div>
        <div className="cx-rows">
          {used.sort((a, b) => b.tokens - a.tokens).map((c) => (
            <div key={c.id} className="cx-row"><i className="cx-sw" style={{ background: SWATCH[c.id] ?? 'var(--muted)' }} /><span className="cx-name">{c.name}</span><span className="cx-num">{fmt(c.tokens)}</span><span className="cx-pct">{pct(c.tokens, max)}</span></div>
          ))}
          {buffer && <div className="cx-row dim"><i className="cx-sw buf" /><span className="cx-name">{buffer.name}</span><span className="cx-num">{fmt(buffer.tokens)}</span><span className="cx-pct">{pct(buffer.tokens, max)}</span></div>}
          {free && <div className="cx-row dim"><i className="cx-sw free" /><span className="cx-name">{free.name}</span><span className="cx-num">{fmt(free.tokens)}</span><span className="cx-pct">{pct(free.tokens, max)}</span></div>}
          {deferred.length > 0 && <div className="cx-sep" />}
          {deferred.map((c) => (
            <div key={c.id} className="cx-row dim" title="Loaded only when the agent needs them, so they don't count against the window yet"><i className="cx-sw def" /><span className="cx-name">{c.name}</span><span className="cx-num">{fmt(c.tokens)}</span><span className="cx-pct">-</span></div>
          ))}
        </div>
        <Group title="Messages" count={data.messages.length} total={byId('messages')} rows={data.messages.map((m) => ({ label: m.label, tokens: m.tokens }))} />
        <Group title="Biggest tools in this conversation" count={data.topTools.length} total={data.topTools.reduce((n, t) => n + t.tokens, 0)} rows={data.topTools.map((t) => ({ label: t.name, tokens: t.tokens }))} />
        <Group title={byId('mcp_tools') > 0 ? 'MCP tools' : 'MCP tools (loaded when needed)'} count={data.mcp.reduce((n, m) => n + m.tools, 0)} total={data.mcp.reduce((n, m) => n + m.tokens, 0)} rows={data.mcp.map((m) => ({ label: m.server, detail: `${m.tools} tools`, tokens: m.tokens }))} />
        <Group title="Memory files" count={data.memoryFiles.length} total={byId('memory_files')} rows={data.memoryFiles.map((m) => ({ label: m.path.split('/').pop() ?? m.path, detail: m.path.replace(window.jarvis.homeDir, '~'), tokens: m.tokens }))} />
        <Group title="Custom agents" count={data.agents.length} total={byId('custom_agents')} rows={data.agents.map((a) => ({ label: a.name, detail: a.source, tokens: a.tokens }))} />
        <Group title="Skills" count={data.skills.length} total={byId('skills')} rows={data.skills.slice(0, 40).map((s) => ({ label: s.name, detail: s.source, tokens: s.tokens }))} />
      </div>
      <div className="cx-foot">
        <span>{until != null ? `${fmt(until)} until auto-compact` : 'auto-compact is off'}</span><span className="strip-spacer" />
        <button className="btn" onClick={onCompact}>Compact session</button>
      </div>
    </div>
  );
}
