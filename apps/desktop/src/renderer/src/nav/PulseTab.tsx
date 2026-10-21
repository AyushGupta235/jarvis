import { useEffect, useState } from 'react';
import type { RateWindow, UsageSummary } from '@jarvis/protocol';
import { fmtTokens, fmtUsd, rpc, until, useStore } from '../store';
import { Empty } from './common';

function windowName(w: RateWindow): string {
  const m = w.windowMinutes;
  if (!m) return 'limit';
  if (m === 300) return '5-hour';
  if (m === 10080) return 'weekly';
  if (m >= 43000) return 'monthly';
  if (m % 1440 === 0) return `${m / 1440}-day`;
  return `${Math.round(m / 60)}-hour`;
}

function Gauge({ label, w, asOf }: { label: string; w: RateWindow | null; asOf?: number | null }) {
  if (!w) return null;
  const stale = !!w.resetsAt && w.resetsAt < Date.now();
  const pct = stale ? 0 : Math.min(100, w.usedPct);
  return (
    <div className="gauge">
      <div className="gauge-top">
        <span>{label} · {windowName(w)}</span>
        <span className={pct > 85 ? 'minus' : ''}>{Math.round(pct)}%</span>
      </div>
      <div className="ctx-bar"><div className={`ctx-fill ${pct > 85 ? 'hot' : pct > 60 ? 'warm' : ''}`} style={{ width: `${pct}%` }} /></div>
      {w.resetsAt && (w.resetsAt > Date.now()
        ? <div className="gauge-sub">resets in {until(w.resetsAt)}</div>
        : <div className="gauge-sub">window has reset since this was recorded{asOf ? ` (${new Date(asOf).toLocaleDateString()})` : ''}</div>)}
    </div>
  );
}

function Big({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="big">
      <div className="big-v">{value}</div>
      <div className="big-l">{label}</div>
      {sub && <div className="big-s">{sub}</div>}
    </div>
  );
}

const pctVs = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : 0);

export function PulseTab() {
  const [u, setU] = useState<UsageSummary | null>(null);
  const limits = useStore((s) => s.snapshot?.limits);
  useEffect(() => {
    let live = true;
    const load = () => void rpc<UsageSummary>('usage.summary', { days: 30 }).then((x) => live && setU(x)).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!u) return <Empty>Crunching your transcripts…</Empty>;
  const p = u.pulse;
  const l = limits ?? u.limits;
  const vs = pctVs(p.today.tokens, p.avgDailyTokens);
  const maxSpark = Math.max(1, ...p.spark.map((d) => d.tokens));
  const maxHour = Math.max(1, ...p.hours);
  const totalMix = p.modelMix.reduce((a, m) => a + m.tokens, 0) || 1;
  const words = Math.round(p.today.outputTokens * 0.75);
  const busiest = p.hours.indexOf(Math.max(...p.hours));
  const fmtHour = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  return (
    <div className="nav-scroll pulse">
      {!u.indexing.done && <div className="nav-warn">Indexing transcripts: {u.indexing.filesDone}/{u.indexing.files} files</div>}

      <section className="pulse-sec">
        <div className="doc-group-title">Plan limits</div>
        <Gauge label="Claude" w={l.claude.fiveHour} asOf={l.claude.asOf} />
        <Gauge label="Claude" w={l.claude.sevenDay} asOf={l.claude.asOf} />
        <Gauge label={`Codex${l.codex.plan ? ` (${l.codex.plan})` : ''}`} w={l.codex.primary} asOf={l.codex.asOf} />
        <Gauge label="Codex" w={l.codex.secondary} asOf={l.codex.asOf} />
        {!l.claude.fiveHour && !l.codex.primary && <div className="muted small">Limits appear once a Claude session started from Jarvis talks to the API, or Codex has run.</div>}
      </section>

      <section className="pulse-sec">
        <div className="doc-group-title">Today</div>
        <div className="bigs">
          <Big value={fmtTokens(p.today.tokens)} label="tokens" sub={p.avgDailyTokens ? `${vs >= 0 ? '+' : ''}${vs}% vs your average` : undefined} />
          <Big value={fmtUsd(p.today.costUsd)} label="API-equivalent" sub={p.avgDailyCostUsd != null ? `avg ${fmtUsd(p.avgDailyCostUsd)}/day` : undefined} />
          <Big value={p.today.toolCalls.toLocaleString()} label="tool calls" sub={p.liveToolCallsPerMin ? `${p.liveToolCallsPerMin}/min right now` : undefined} />
          <Big value={p.today.linesWritten.toLocaleString()} label="lines written by agents" />
          <Big value={fmtTokens(words)} label="words of output" sub={`≈ ${Math.max(1, Math.round(words / 500)).toLocaleString()} pages`} />
          <Big value={String(p.today.sessions)} label="sessions" sub={`peak ${p.today.peakConcurrent} at once${p.workingNow ? ` · ${p.workingNow} working now` : ''}`} />
        </div>
      </section>

      <section className="pulse-sec">
        <div className="doc-group-title">Last 30 days</div>
        <div className="spark" title="tokens per day">
          {p.spark.map((d) => (
            <div key={d.day} className="spark-col" title={`${d.day}: ${fmtTokens(d.tokens)} tokens${d.costUsd != null ? `, ${fmtUsd(d.costUsd)}` : ''}`}>
              <div className="spark-bar" style={{ height: `${Math.max(d.tokens ? 4 : 0, (d.tokens / maxSpark) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="bigs">
          <Big value={`${p.streakDays}🔥`} label="day streak" sub={`${p.activeDays30}/30 days active`} />
          <Big value={p.cacheHitPct != null ? `${p.cacheHitPct}%` : '–'} label="cache hit rate" sub={p.cacheSavedUsd ? `saved ≈ ${fmtUsd(p.cacheSavedUsd)}` : undefined} />
          {p.records.peakConcurrent && <Big value={String(p.records.peakConcurrent.sessions)} label="most sessions at once" sub={p.records.peakConcurrent.day} />}
          {p.records.bestDay && <Big value={fmtTokens(p.records.bestDay.tokens)} label="biggest day ever" sub={p.records.bestDay.day} />}
        </div>
      </section>

      <section className="pulse-sec">
        <div className="doc-group-title">When you work · busiest {fmtHour(busiest)}</div>
        <div className="hours">
          {p.hours.map((h, i) => (
            <div key={i} className="hour" title={`${fmtHour(i)}: ${fmtTokens(h)} tokens`} style={{ opacity: 0.12 + 0.88 * (h / maxHour) }} />
          ))}
        </div>
        <div className="hours-axis"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
      </section>

      <section className="pulse-sec">
        <div className="doc-group-title">Models</div>
        <div className="mix">
          {p.modelMix.map((m, i) => <div key={m.model} className={`mix-seg c${i}`} style={{ width: `${(m.tokens / totalMix) * 100}%` }} title={`${m.model}: ${fmtTokens(m.tokens)}`} />)}
        </div>
        <div className="mix-legend">
          {p.modelMix.map((m, i) => <span key={m.model}><i className={`c${i}`} />{m.model.replace(/^claude-/, '')} {Math.round((m.tokens / totalMix) * 100)}%</span>)}
        </div>
      </section>

      <section className="pulse-sec">
        <div className="doc-group-title">Top tools · today / 30 days</div>
        <div className="toolbars">
          {p.topTools30.slice(0, 8).map((t) => {
            const today = p.topToolsToday.find((x) => x.tool === t.tool)?.calls ?? 0;
            return (
              <div key={t.tool} className="toolbar">
                <span className="tb-tool">{t.tool}</span>
                <div className="tb-bar"><div style={{ width: `${(t.calls / (p.topTools30[0]?.calls || 1)) * 100}%` }} /></div>
                <span className="tb-n">{today ? `${today.toLocaleString()} / ` : ''}{t.calls.toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="pulse-sec">
        <div className="doc-group-title">Top repos · 7 days</div>
        {u.topProjects.slice(0, 8).map((r) => (
          <div key={`${r.agent}:${r.project}`} className="toolbar">
            <span className="tb-tool">{r.project.split('/').pop()}</span>
            <div className="tb-bar"><div style={{ width: `${(r.tokens / (u.topProjects[0]?.tokens || 1)) * 100}%` }} /></div>
            <span className="tb-n">{fmtTokens(r.tokens)} · {fmtUsd(r.costUsd)}</span>
          </div>
        ))}
        <div className="muted small">Costs are API-list-price equivalents ({u.pricingSource ?? 'no price table'}), not your bill.</div>
      </section>
    </div>
  );
}
