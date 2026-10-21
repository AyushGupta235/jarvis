import { useState } from 'react';
import type { Connector, PullRequest, SessionInfo } from '@jarvis/protocol';
import { useEffect } from 'react';
import { ago, rpc, useStore } from '../store';
import { Empty } from './common';

export function checksIcon(c: PullRequest['checks']): { icon: string; cls: string; label: string } {
  if (c === 'SUCCESS') return { icon: '✓', cls: 'ok', label: 'checks passed' };
  if (c === 'FAILURE' || c === 'ERROR') return { icon: '✗', cls: 'bad', label: 'checks failing' };
  if (c === 'PENDING' || c === 'EXPECTED') return { icon: '●', cls: 'pending', label: 'checks running' };
  return { icon: '○', cls: 'none', label: 'no checks' };
}

function reviewLabel(r: PullRequest['review']): string | null {
  if (r === 'APPROVED') return 'approved';
  if (r === 'CHANGES_REQUESTED') return 'changes requested';
  if (r === 'REVIEW_REQUIRED') return 'needs review';
  return null;
}

function PrRow({ p, multi }: { p: PullRequest; multi: boolean }) {
  const c = checksIcon(p.checks);
  const rv = reviewLabel(p.review);
  return (
    <div className="pr-row" onClick={() => window.jarvis.openExternal(p.url)} title={`${p.repo}#${p.number}\n${p.headRef} → ${p.baseRef}`}>
      <span className={`pr-checks ${c.cls}`} title={c.label}>{c.icon}</span>
      <div className="pr-main">
        <div className="pr-title">{p.isDraft && <span className="tag">draft</span>}{p.title}</div>
        <div className="pr-meta">
          <span>{p.repo.split('/')[1]}#{p.number}</span>
          {rv && <span className={`pr-review ${p.review?.toLowerCase()}`}>{rv}</span>}
          {p.mergeable === 'CONFLICTING' && <span className="pr-review changes_requested">conflicts</span>}
          {p.comments > 0 && <span>💬 {p.comments}</span>}
          <span className="plus">+{p.additions}</span><span className="minus">−{p.deletions}</span>
          {multi && <span className="pr-acct">{p.account}</span>}
          <span className="strip-spacer" />
          <span>{ago(Date.parse(p.updatedAt))}</span>
        </div>
      </div>
    </div>
  );
}

export function PrsTab({ s }: { s: SessionInfo | null }) {
  const prs = useStore((st) => st.snapshot?.prs);
  const [busy, setBusy] = useState(false);
  if (!prs) return <Empty>Loading…</Empty>;
  const multi = prs.accounts.length > 1;
  const mine = prs.prs.filter((p) => p.role === 'author');
  const review = prs.prs.filter((p) => p.role === 'reviewer');
  const failing = mine.filter((p) => p.checks === 'FAILURE' || p.checks === 'ERROR').length;
  return (
    <div className="nav-col">
      <div className="nav-head">
        <span>{mine.length} open · {review.length} to review{failing ? ` · ` : ''}{failing ? <span className="minus">{failing} failing</span> : null}</span>
        <span className="strip-spacer" />
        <span className="muted">{prs.updatedAt ? `updated ${ago(prs.updatedAt)} ago` : ''}</span>
        <button className="icon-btn" disabled={busy} title="Refresh" onClick={async () => {
          setBusy(true);
          await rpc('prs.refresh').finally(() => setBusy(false));
        }}>{busy ? '…' : '↻'}</button>
      </div>
      {prs.error && <div className="nav-warn">{prs.error}</div>}
      <div className="nav-scroll">
        {s?.pr && (
          <section className="doc-group">
            <div className="doc-group-title">This session's branch</div>
            <PrRow p={s.pr} multi={multi} />
          </section>
        )}
        {review.length > 0 && (
          <section className="doc-group">
            <div className="doc-group-title">Waiting on your review</div>
            {review.map((p) => <PrRow key={`${p.repo}#${p.number}`} p={p} multi={multi} />)}
          </section>
        )}
        <section className="doc-group">
          <div className="doc-group-title">Yours ({prs.accounts.join(', ')})</div>
          {mine.map((p) => <PrRow key={`${p.repo}#${p.number}`} p={p} multi={multi} />)}
          {!mine.length && <Empty>No open pull requests.</Empty>}
        </section>
      </div>
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
