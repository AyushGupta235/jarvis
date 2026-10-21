import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MERGED_WINDOW_DAYS, type Connector, type PullRequest, type SessionInfo } from '@jarvis/protocol';
import { ago, rpc, useStore } from '../store';
import { Empty } from './common';

export function checksIcon(c: PullRequest['checks']): { icon: string; cls: string; label: string } {
  if (c === 'SUCCESS') return { icon: '✓', cls: 'ok', label: 'checks passed' };
  if (c === 'FAILURE' || c === 'ERROR') return { icon: '✗', cls: 'bad', label: 'checks failing' };
  if (c === 'PENDING' || c === 'EXPECTED') return { icon: '●', cls: 'pending', label: 'checks running' };
  return { icon: '○', cls: 'none', label: 'no checks' };
}

/** Icon for a PR badge (sidebar, title bar): merged PRs show as merged, open ones by their checks. */
export function prIcon(p: PullRequest): { icon: string; cls: string; label: string } {
  if (p.state === 'MERGED') return { icon: '◆', cls: 'merged', label: `merged ${p.mergedAt ? `${ago(Date.parse(p.mergedAt))} ago` : ''}`.trim() };
  if (p.state === 'CLOSED') return { icon: '○', cls: 'none', label: 'closed' };
  return checksIcon(p.checks);
}

type Status = { key: 'merged' | 'draft' | 'conflicts' | 'failing' | 'changes' | 'ready' | 'review' | 'running' | 'open'; label: string };

/** The one thing to know about a PR, in priority order. */
export function prStatus(p: PullRequest): Status {
  if (p.state === 'MERGED') return { key: 'merged', label: 'merged' };
  if (p.isDraft) return { key: 'draft', label: 'draft' };
  if (p.mergeable === 'CONFLICTING') return { key: 'conflicts', label: 'conflicts' };
  if (p.checks === 'FAILURE' || p.checks === 'ERROR') return { key: 'failing', label: 'checks failing' };
  if (p.review === 'CHANGES_REQUESTED') return { key: 'changes', label: 'changes requested' };
  if (p.review === 'APPROVED' && p.checks !== 'PENDING' && p.checks !== 'EXPECTED') return { key: 'ready', label: 'ready to merge' };
  if (p.checks === 'PENDING' || p.checks === 'EXPECTED') return { key: 'running', label: 'checks running' };
  if (p.review === 'REVIEW_REQUIRED') return { key: 'review', label: 'needs review' };
  return { key: 'open', label: 'open' };
}

function PrRow({ p, multi }: { p: PullRequest; multi: boolean }) {
  const c = prIcon(p);
  const st = prStatus(p);
  const when = p.state === 'MERGED' && p.mergedAt ? p.mergedAt : p.updatedAt;
  return (
    <div className="pr-row" onClick={() => window.jarvis.openExternal(p.url)} title={`${p.repo}#${p.number}\n${p.headRef} → ${p.baseRef}\n${c.label}`}>
      <span className={`pr-checks ${c.cls}`} title={c.label}>{c.icon}</span>
      <div className="pr-main">
        <div className="pr-title">{p.title}</div>
        <div className="pr-meta">
          <span className={`pr-status ${st.key}`}>{st.label}</span>
          <span>{p.repo.split('/')[1]}#{p.number}</span>
          {p.role === 'reviewer' && <span className="muted">review requested</span>}
          {p.comments > 0 && <span>💬 {p.comments}</span>}
          <span className="plus">+{p.additions}</span><span className="minus">−{p.deletions}</span>
          {multi && <span className="pr-acct">{p.account}</span>}
          <span className="strip-spacer" />
          <span title={new Date(when).toLocaleString()}>{ago(Date.parse(when))}</span>
        </div>
      </div>
    </div>
  );
}

type Filter = 'all' | 'mine' | 'review' | 'ready' | 'attention' | 'merged';
const FILTERS: { key: Filter; label: string; test: (p: PullRequest) => boolean }[] = [
  { key: 'all', label: 'open', test: (p) => p.state === 'OPEN' },
  { key: 'mine', label: 'mine', test: (p) => p.state === 'OPEN' && p.role === 'author' },
  { key: 'review', label: 'to review', test: (p) => p.state === 'OPEN' && p.role === 'reviewer' },
  { key: 'ready', label: 'ready', test: (p) => p.state === 'OPEN' && prStatus(p).key === 'ready' },
  { key: 'attention', label: 'needs work', test: (p) => p.state === 'OPEN' && p.role === 'author' && ['conflicts', 'failing', 'changes'].includes(prStatus(p).key) },
  { key: 'merged', label: 'merged', test: (p) => p.state === 'MERGED' },
];

function mergedBucket(iso: string | null): string {
  if (!iso) return 'Earlier';
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  return `Earlier (last ${MERGED_WINDOW_DAYS} days)`;
}

export function PrsTab({ s }: { s: SessionInfo | null }) {
  const prs = useStore((st) => st.snapshot?.prs);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const counts = useMemo(() => new Map(FILTERS.map((f) => [f.key, (prs?.prs ?? []).filter(f.test).length])), [prs]);
  if (!prs) return <Empty>Loading…</Empty>;
  const multi = prs.accounts.length > 1;
  const needle = q.trim().toLowerCase();
  const matches = (p: PullRequest) => !needle ||
    `${p.title} ${p.repo} #${p.number} ${p.headRef} ${p.account} ${prStatus(p).label}`.toLowerCase().includes(needle);
  const f = FILTERS.find((x) => x.key === filter)!;
  const shown = prs.prs.filter((p) => f.test(p) && matches(p));
  const key = (p: PullRequest) => `${p.account}:${p.repo}#${p.number}`;
  const rows = (list: PullRequest[]) => list.map((p) => <PrRow key={key(p)} p={p} multi={multi} />);

  let body: ReactNode;
  if (filter === 'merged') {
    const merged = [...shown].sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''));
    const groups = new Map<string, PullRequest[]>();
    for (const p of merged) groups.set(mergedBucket(p.mergedAt), [...(groups.get(mergedBucket(p.mergedAt)) ?? []), p]);
    const week = merged.filter((p) => p.mergedAt && Date.now() - Date.parse(p.mergedAt) < 7 * 86_400_000);
    body = (
      <>
        {week.length > 0 && !needle && (
          <div className="pr-shipped">
            <b>{week.length}</b> merged in the last 7 days · <span className="plus">+{week.reduce((n, p) => n + p.additions, 0).toLocaleString()}</span>{' '}
            <span className="minus">−{week.reduce((n, p) => n + p.deletions, 0).toLocaleString()}</span>
            {' '}across {new Set(week.map((p) => p.repo)).size} repo{new Set(week.map((p) => p.repo)).size === 1 ? '' : 's'}
          </div>
        )}
        {[...groups.entries()].map(([g, list]) => (
          <section key={g} className="doc-group">
            <div className="doc-group-title">{g}</div>
            {rows(list)}
          </section>
        ))}
        {!merged.length && <Empty>{needle ? 'Nothing matches.' : `No merged PRs in the last ${MERGED_WINDOW_DAYS} days.`}</Empty>}
      </>
    );
  } else if (filter === 'all') {
    const review = shown.filter((p) => p.role === 'reviewer');
    const mine = shown.filter((p) => p.role === 'author');
    body = (
      <>
        {s?.pr && !needle && (
          <section className="doc-group">
            <div className="doc-group-title">This session's branch</div>
            <PrRow p={s.pr} multi={multi} />
          </section>
        )}
        {review.length > 0 && (
          <section className="doc-group">
            <div className="doc-group-title">Waiting on your review</div>
            {rows(review)}
          </section>
        )}
        <section className="doc-group">
          <div className="doc-group-title">Yours</div>
          {rows(mine)}
          {!mine.length && <Empty>{needle ? 'Nothing matches.' : 'No open pull requests.'}</Empty>}
        </section>
      </>
    );
  } else {
    body = shown.length ? <section className="doc-group">{rows(shown)}</section> : <Empty>Nothing matches.</Empty>;
  }

  return (
    <div className="nav-col">
      <div className="nav-head">
        <span className="muted">{prs.accounts.join(' · ') || 'No gh accounts'}</span>
        <span className="strip-spacer" />
        <span className="muted" title="Refreshes every 2 minutes">{prs.updatedAt ? `${ago(prs.updatedAt)} ago` : ''}</span>
        <button className="icon-btn" disabled={busy} title="Refresh" onClick={async () => {
          setBusy(true);
          await rpc('prs.refresh').finally(() => setBusy(false));
        }}>{busy ? '…' : '↻'}</button>
      </div>
      <div className="nav-filters">
        {FILTERS.map((x) => (
          <button key={x.key} className={`filter ${filter === x.key ? 'on' : ''} ${x.key === 'attention' && counts.get(x.key) ? 'warn' : ''}`} onClick={() => setFilter(x.key)}>
            {x.label} {counts.get(x.key) ? <span className="filter-n">{counts.get(x.key)}</span> : null}
          </button>
        ))}
        <input className="pr-search" placeholder="Filter by title, repo, branch…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} />
      </div>
      {prs.error && <div className="nav-warn">{prs.error}</div>}
      <div className="nav-scroll">{body}</div>
    </div>
  );
}

export function ConnectorsTab({ s }: { s: SessionInfo }) {
  const [list, setList] = useState<Connector[] | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setList(null);
    setCheck(null);
    if (!s.external) void rpc<Connector[]>('connectors.list', { id: s.id }).then(setList).catch(() => setList([]));
  }, [s.id, s.external]);
  if (s.external) return <Empty>Connectors are listed for Jarvis sessions.</Empty>;
  const groups = new Map<string, Connector[]>();
  for (const c of list ?? []) {
    const g = c.agent === 'codex' ? 'Codex' : c.scope === 'claude.ai' ? 'Claude connectors (claude.ai / desktop)' : `Claude MCP servers`;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  return (
    <div className="nav-col">
      <div className="nav-head">
        <span>{list ? `${list.length} connectors` : 'Loading…'}</span>
        <span className="strip-spacer" />
        <button className="chip-btn" disabled={checking} onClick={async () => {
          setChecking(true);
          const r = await rpc<{ output: string }>('connectors.check', { id: s.id }).finally(() => setChecking(false));
          setCheck(r.output);
        }}>{checking ? 'Checking…' : 'Check health'}</button>
      </div>
      <div className="nav-scroll">
        {check && <pre className="check-out">{check}</pre>}
        {[...groups.entries()].map(([g, cs]) => (
          <section key={g} className="doc-group">
            <div className="doc-group-title">{g}</div>
            {cs.map((c) => (
              <div key={`${c.agent}:${c.name}`} className="conn-row" title={c.detail ?? ''}>
                <span className={`conn-dot ${c.recentCalls > 0 ? 'used' : ''}`} />
                <div className="pr-main">
                  <div className="pr-title">{c.name}</div>
                  <div className="pr-meta">
                    <span className="tag">{c.scope}</span>
                    {c.transport && <span>{c.transport}</span>}
                    {c.detail && <span className="muted">{c.detail}</span>}
                  </div>
                </div>
                <div className="conn-calls">
                  <div>{c.recentCalls ? c.recentCalls.toLocaleString() : '–'}</div>
                  <div className="muted">{c.lastUsed ? `${ago(c.lastUsed)} ago` : 'calls / 30d'}</div>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
