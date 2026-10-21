import { useEffect, useMemo, useState } from 'react';
import type { SessionInfo } from '@jarvis/protocol';
import { activity, agentDef, ago, fmtUsd, groups, setState, tildify, until, useStore } from './store';
import { checksIcon } from './nav/PrsTab';
import { activate, sessionContextMenu } from './actions';

function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Sidebar() {
  const snapshot = useStore((s) => s.snapshot);
  const showHidden = useStore((s) => s.showHidden);
  const collapsed = useStore((s) => s.collapsed);
  const activeId = useStore((s) => s.activeId);
  const connected = useStore((s) => s.status.connected);
  const now = useNow();
  const gs = useMemo(() => groups(snapshot, showHidden), [snapshot, showHidden]);
  const hiddenCount = (snapshot?.sessions ?? []).filter((s) => s.hidden).length;

  const fallbackActive = gs.find((g) => !collapsed[g.ws.root])?.sessions[0]?.id;
  const current = snapshot?.sessions.some((s) => s.id === activeId) ? activeId : fallbackActive;

  let n = 0;
  const counts = { working: 0, needs_input: 0, done: 0, idle: 0, exited: 0 };
  for (const s of snapshot?.sessions ?? []) counts[activity(s, now)]++;
  const limits = snapshot?.limits;

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="brand">Jarvis</span>
        <span className={`daemon-dot ${connected ? 'ok' : 'down'}`} title={connected ? 'jarvisd connected' : 'jarvisd not reachable'} />
        <button className="icon-btn no-drag" title="New session (⌘T)" onClick={() => setState({ dialog: { kind: 'new' } })}>＋</button>
      </div>
      <div className="sidebar-scroll">
        {gs.map((g) => {
          const isCollapsed = !!collapsed[g.ws.root];
          return (
            <section key={g.ws.root} className="group">
              <div className="group-head">
                <button
                  className="group-toggle"
                  onClick={() => setState((s) => ({ collapsed: { ...s.collapsed, [g.ws.root]: !isCollapsed } }))}
                  title={g.ws.root}
                >
                  <span className={`chev ${isCollapsed ? 'closed' : ''}`}>▾</span>
                  <span className="group-name">{g.ws.name}</span>
                  <span className="group-count">{g.sessions.length}</span>
                </button>
                {g.ws.root !== 'tmux:default' && (
                  <button className="icon-btn small" title={`New session in ${g.ws.name}`}
                    onClick={() => setState({ dialog: { kind: 'new', repoPath: g.ws.root } })}>＋</button>
                )}
              </div>
              {!isCollapsed && g.sessions.map((s) => (
                <Row key={s.id} s={s} index={n++} active={s.id === current} now={now} />
              ))}
            </section>
          );
        })}
      </div>
      <div className="sidebar-foot">
        {limits && (limits.claude.fiveHour || limits.codex.primary) && (
          <button className="limits" title="Plan limits · open Pulse" onClick={() => setState({ navOpen: true, navTab: 'usage' })}>
            {limits.claude.fiveHour && <Lim label="5h" pct={limits.claude.fiveHour.usedPct} reset={limits.claude.fiveHour.resetsAt} />}
            {limits.claude.sevenDay && <Lim label="7d" pct={limits.claude.sevenDay.usedPct} reset={limits.claude.sevenDay.resetsAt} />}
            {limits.codex.primary && (!limits.codex.primary.resetsAt || limits.codex.primary.resetsAt > Date.now()) &&
              <Lim label="cx" pct={limits.codex.primary.usedPct} reset={limits.codex.primary.resetsAt} />}
          </button>
        )}
        {counts.needs_input > 0 && <span className="stat"><i className="dot needs_input" />{counts.needs_input} need you</span>}
        <span className="stat"><i className="dot working" />{counts.working} working</span>
        {counts.done > 0 && <span className="stat"><i className="dot done" />{counts.done} done</span>}
        <span className="stat"><i className="dot idle" />{counts.idle} idle</span>
        {counts.exited > 0 && <span className="stat"><i className="dot exited" />{counts.exited} ended</span>}
        {hiddenCount > 0 && (
          <button className="link" onClick={() => setState((s) => ({ showHidden: !s.showHidden }))}>
            {showHidden ? 'hide' : 'show'} {hiddenCount} hidden
          </button>
        )}
      </div>
    </aside>
  );
}

function Lim({ label, pct, reset }: { label: string; pct: number; reset: number | null }) {
  return (
    <span className="lim" title={`${label}: ${Math.round(pct)}% used${reset ? `, resets in ${until(reset)}` : ''}`}>
      <span className="lim-l">{label}</span>
      <span className="lim-bar"><span className={pct > 85 ? 'hot' : pct > 60 ? 'warm' : ''} style={{ width: `${Math.min(100, pct)}%` }} /></span>
    </span>
  );
}

/** Tiny context-window ring for sidebar rows. */
function Ring({ pct }: { pct: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${pct > 80 ? 'hot' : pct > 60 ? 'warm' : ''}`} width="16" height="16" viewBox="0 0 16 16">
      <title>{`context ${Math.round(pct)}%`}</title>
      <circle cx="8" cy="8" r={r} className="ring-bg" />
      <circle cx="8" cy="8" r={r} className="ring-fg" strokeDasharray={`${(Math.min(100, pct) / 100) * c} ${c}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}

function Row({ s, index, active, now }: { s: SessionInfo; index: number; active: boolean; now: number }) {
  const def = useStore((st) => agentDef(st, s.agent));
  const unread = useStore((st) => st.unread[s.id]);
  const act = activity(s, now);
  const a = s.agentState;
  const where = s.worktree ? `⑂ ${s.worktree.split('/').pop()}` : null;
  const base = [where, s.branch, def?.command ? `${def.label.split(' ')[0]?.toLowerCase()}${a?.model || s.model ? ` ${a?.model ?? s.model}` : ''}` : s.paneCommand]
    .filter(Boolean).join(' · ');
  const meta = act === 'needs_input' ? a?.message || 'needs your input'
    : act === 'working' && a?.tool ? a.tool
    : a?.title && a.title !== s.name ? `${a.title} · ${base}` : base;
  const pct = a?.context?.usedPct ?? null;
  const pr = s.pr ? checksIcon(s.pr.checks) : null;
  return (
    <div
      className={`row ${active ? 'active' : ''} ${s.hidden ? 'is-hidden' : ''} ${act} ${unread && !active ? 'unread' : ''}`}
      data-id={s.id}
      onClick={() => activate(s.id)}
      onDoubleClick={() => !s.external && setState({ dialog: { kind: 'rename', id: s.id } })}
      onContextMenu={(e) => {
        e.preventDefault();
        void sessionContextMenu(s);
      }}
      title={`${s.name}\n${def?.label ?? s.agent}\n${tildify(s.currentPath || s.cwd)}${s.agentSessionId ? `\nsession ${s.agentSessionId}` : ''}`}
    >
      <i className={`dot ${act}`} />
      <div className="row-main">
        <div className="row-title">
          <span className={`glyph ${s.agent}`}>{def?.glyph ?? s.agent.slice(0, 1)}</span>
          <span className="name">{s.name}</span>
        </div>
        <div className={`row-meta ${act === 'needs_input' ? 'alert' : act === 'working' && a?.tool ? 'tool' : ''}`}>{meta}</div>
      </div>
      <div className="row-side">
        <div className="row-badges">
          {pr && <span className={`pr-mini ${pr.cls}`} title={`#${s.pr!.number} ${s.pr!.title}\n${pr.label}`}>{pr.icon}{s.pr!.number}</span>}
          {pct != null && <Ring pct={pct} />}
          {index < 9 && pct == null && !pr && <span className="kbd-hint">⌘{index + 1}</span>}
        </div>
        <span className="age">{act === 'working' ? (a?.costUsd ? fmtUsd(a.costUsd) : '') : ago(act === 'exited' ? s.exitedAt : (a?.since ?? s.lastActivity), now)}</span>
      </div>
    </div>
  );
}
