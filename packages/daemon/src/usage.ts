import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Pulse, RateWindow, UsageDay, UsageSummary } from '@jarvis/protocol';
import { readNewLines } from './jsonl';
import { codexHome } from './codex';
import { log, logError } from './log';
import { nameFromTool } from './connectors';

const PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Collapse worktrees into their repo: /x/repo/.claude/worktrees/foo -> /x/repo */
export function projectOf(cwd: string): string {
  return cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '').replace(/\/\.worktrees\/[^/]+.*$/, '');
}

function listClaudeFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const proj of readdirSync(root)) {
    const pdir = join(root, proj);
    let entries: string[];
    try {
      entries = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith('.jsonl')) out.push(join(pdir, e));
      else {
        const sub = join(pdir, e, 'subagents');
        if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) out.push(join(sub, f));
      }
    }
  }
  return out;
}

function listCodexFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      if (depth < 3) walk(p, depth + 1);
      else if (e.startsWith('rollout-') && e.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(join(root, 'sessions'), 0);
  return out;
}

/**
 * Indexes token usage from Claude transcripts (~/.claude/projects) and Codex rollouts (~/.codex/sessions)
 * into SQLite, incrementally by byte offset, and tracks the latest Codex plan limits.
 */
export class UsageIndexer {
  private prices = new Map<string, Price>();
  private pricingSource: string | null = null;
  private running = false;
  private progress = { done: false, files: 0, filesDone: 0 };
  codexLimits: UsageSummary['limits']['codex'] = { primary: null, secondary: null, plan: null, asOf: null };
  private extra: { upToolDay: ReturnType<DatabaseSync['prepare']>; upLines: ReturnType<DatabaseSync['prepare']> } | null = null;
  onLimits: (() => void) | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly home: string,
    private readonly claudeRoot = join(homedir(), '.claude', 'projects'),
    private readonly codexRoot = codexHome(),
  ) {}

  start(): void {
    void this.loadPricing();
    setTimeout(() => void this.run(), 3000);
    setInterval(() => void this.run(), 60_000);
  }

  private async loadPricing(): Promise<void> {
    const cache = join(this.home, 'pricing.json');
    let raw: string | null = null;
    try {
      if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 86_400_000) raw = readFileSync(cache, 'utf8');
      else {
        const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          raw = await res.text();
          writeFileSync(cache, raw);
        } else if (existsSync(cache)) raw = readFileSync(cache, 'utf8');
      }
    } catch (e) {
      if (existsSync(cache)) raw = readFileSync(cache, 'utf8');
      else logError('pricing fetch failed:', (e as Error).message);
    }
    if (!raw) return;
    try {
      const j = JSON.parse(raw) as Record<string, Record<string, number>>;
      for (const [k, v] of Object.entries(j)) {
        if (typeof v?.input_cost_per_token !== 'number') continue;
        this.prices.set(k, {
          input: v.input_cost_per_token, output: v.output_cost_per_token ?? 0,
          cacheRead: v.cache_read_input_token_cost ?? v.input_cost_per_token * 0.1,
          cacheWrite: v.cache_creation_input_token_cost ?? v.input_cost_per_token * 1.25,
        });
      }
      this.pricingSource = 'LiteLLM model price table';
    } catch (e) {
      logError('pricing parse failed:', (e as Error).message);
    }
  }

  price(model: string): Price | null {
    const cands = [model, `anthropic/${model}`, `openai/${model}`, model.replace(/-\d{8}$/, ''), model.replace(/\[.*\]$/, '')];
    for (const c of cands) {
      const p = this.prices.get(c);
      if (p) return p;
    }
    return null;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const t0 = Date.now();
    try {
      const claude = listClaudeFiles(this.claudeRoot);
      const codex = listCodexFiles(this.codexRoot);
      this.progress = { done: this.progress.done, files: claude.length + codex.length, filesDone: 0 };
      const offsets = new Map(
        (this.db.prepare('select path, offset, meta from usage_files').all() as { path: string; offset: number; meta: string | null }[])
          .map((r) => [r.path, r]),
      );
      const upMsg = this.db.prepare(`insert or replace into usage_msgs (key, ts, day, agent, model, project, input, output, cache_read, cache_write, session)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const upToolDay = this.db.prepare(`insert into tool_day (day, tool, calls) values (?, ?, 1)
        on conflict (day, tool) do update set calls = calls + 1`);
      const upLines = this.db.prepare(`insert into lines_day (day, added, removed) values (?, ?, ?)
        on conflict (day) do update set added = added + excluded.added, removed = removed + excluded.removed`);
      this.extra = { upToolDay, upLines };
      const upTool = this.db.prepare(`insert into tool_seen (server, day, calls, last_used, sample) values (?, ?, 1, ?, ?)
        on conflict (server, day) do update set calls = calls + 1, last_used = max(last_used, excluded.last_used),
          sample = coalesce(sample, excluded.sample)`);
      const upFile = this.db.prepare('insert or replace into usage_files (path, offset, size, meta) values (?, ?, ?, ?)');
      let n = 0;
      for (const f of claude) {
        const prev = offsets.get(f);
        let size: number;
        try {
          size = statSync(f).size;
        } catch {
          continue;
        }
        if (prev && prev.offset === size) { this.progress.filesDone++; continue; }
        let offset = prev?.offset ?? 0;
        this.db.exec('begin');
        try {
          for (;;) {
            const r = readNewLines(f, offset);
            for (const line of r.lines) this.claudeLine(line, upMsg, upTool);
            const moved = r.offset !== offset;
            offset = r.offset;
            if (!moved || offset >= r.size) break;
          }
          upFile.run(f, offset, size, null);
          this.db.exec('commit');
        } catch (e) {
          this.db.exec('rollback');
          logError('usage index failed for', f, (e as Error).message);
        }
        this.progress.filesDone++;
        if (++n % 25 === 0) await new Promise((r) => setImmediate(r));
      }
      for (const f of codex) {
        const prev = offsets.get(f);
        const meta = prev?.meta ? (JSON.parse(prev.meta) as { model?: string; cwd?: string }) : {};
        let offset = prev?.offset ?? 0;
        let size: number;
        try {
          size = statSync(f).size;
        } catch {
          continue;
        }
        if (prev && prev.offset === size) { this.progress.filesDone++; continue; }
        this.db.exec('begin');
        try {
          for (;;) {
            const r = readNewLines(f, offset);
            for (const [i, line] of r.lines.entries()) this.codexLine(f, offset + i, line, meta, upMsg);
            const moved = r.offset !== offset;
            offset = r.offset;
            if (!moved || offset >= r.size) break;
          }
          upFile.run(f, offset, size, JSON.stringify(meta));
          this.db.exec('commit');
        } catch (e) {
          this.db.exec('rollback');
          logError('codex usage index failed for', f, (e as Error).message);
        }
        this.progress.filesDone++;
      }
      if (!this.progress.done) log(`usage index ready: ${claude.length} Claude + ${codex.length} Codex files in ${Math.round((Date.now() - t0) / 1000)}s`);
      this.progress.done = true;
    } finally {
      this.running = false;
    }
  }

  private claudeLine(line: string, upMsg: ReturnType<DatabaseSync['prepare']>, upTool: ReturnType<DatabaseSync['prepare']>): void {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) return;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    const m = d.message;
    if (d.type !== 'assistant' || !m?.usage || !m.id || !m.model || m.model === '<synthetic>') return;
    const ts = Date.parse(d.timestamp) || Date.now();
    const u = m.usage;
    const day = localDay(ts);
    upMsg.run(`c:${m.id}:${d.requestId ?? ''}`, ts, day, 'claude', m.model, projectOf(d.cwd ?? 'unknown'),
      u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, d.sessionId ?? null);
    for (const b of m.content ?? []) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
      this.extra?.upToolDay.run(day, b.name.startsWith('mcp__') ? `mcp:${b.name.split('__')[1]}` : b.name);
      const i = b.input ?? {};
      if (b.name === 'Write' && typeof i.content === 'string') this.extra?.upLines.run(day, i.content.split('\n').length, 0);
      if (b.name === 'Edit' && typeof i.new_string === 'string') {
        this.extra?.upLines.run(day, i.new_string.split('\n').length, typeof i.old_string === 'string' ? i.old_string.split('\n').length : 0);
      }
      if (b.name.startsWith('mcp__')) {
        const [, server, tool] = b.name.split('__');
        upTool.run(server ?? b.name, localDay(ts), ts, tool ?? null);
      }
    }
  }

  private codexLine(file: string, idx: number, line: string, meta: { model?: string; cwd?: string }, upMsg: ReturnType<DatabaseSync['prepare']>): void {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')
      && !line.includes('"function_call"') && !line.includes('"custom_tool_call"')) return;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    const p = d.payload ?? {};
    if (d.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      this.extra?.upToolDay.run(localDay(Date.parse(d.timestamp) || Date.now()), `codex:${p.name ?? 'tool'}`);
      return;
    }
    if (d.type === 'session_meta') meta.cwd = p.cwd;
    else if (d.type === 'turn_context') meta.model = p.model;
    else if (p.type === 'token_count') {
      const ts = Date.parse(d.timestamp) || Date.now();
      const u = p.info?.last_token_usage;
      if (u) {
        const cached = u.cached_input_tokens ?? 0;
        upMsg.run(`x:${basename(file)}:${idx}`, ts, localDay(ts), 'codex', meta.model ?? 'codex', projectOf(meta.cwd ?? 'unknown'),
          Math.max(0, (u.input_tokens ?? 0) - cached), u.output_tokens ?? 0, cached, u.cache_write_input_tokens ?? 0, basename(file));
      }
      const rl = p.rate_limits;
      if (rl && (!this.codexLimits.asOf || ts >= this.codexLimits.asOf)) {
        const win = (w: any): RateWindow | null =>
          w ? { usedPct: w.used_percent ?? 0, resetsAt: w.resets_at ? w.resets_at * 1000 : null, windowMinutes: w.window_minutes ?? null } : null;
        this.codexLimits = { primary: win(rl.primary), secondary: win(rl.secondary), plan: rl.plan_type ?? null, asOf: ts };
        this.onLimits?.();
      }
    }
  }

  recentServers(days = 30): Map<string, { calls: number; lastUsed: number; sample: string | null }> {
    const since = localDay(Date.now() - days * 86_400_000);
    const rows = this.db.prepare('select server, sum(calls) as calls, max(last_used) as last, max(sample) as sample from tool_seen where day >= ? group by server')
      .all(since) as { server: string; calls: number; last: number; sample: string | null }[];
    return new Map(rows.map((r) => [r.server, { calls: r.calls, lastUsed: r.last, sample: r.sample }]));
  }

  /** Map usage rows' working directories onto known repo roots (subfolders and worktrees roll up). */
  projectResolver: ((cwd: string) => string) | null = null;

  summary(days = 30, claudeLimits: UsageSummary['limits']['claude']): UsageSummary {
    const since = localDay(Date.now() - (days - 1) * 86_400_000);
    const rows = this.db.prepare(`select day, agent, model, sum(input) as input, sum(output) as output, sum(cache_read) as cr, sum(cache_write) as cw
      from usage_msgs where day >= ? group by day, agent, model order by day`).all(since) as {
      day: string; agent: 'claude' | 'codex'; model: string; input: number; output: number; cr: number; cw: number;
    }[];
    const cost = (model: string, i: number, o: number, cr: number, cw: number) => {
      const p = this.price(model);
      return p ? i * p.input + o * p.output + cr * p.cacheRead + cw * p.cacheWrite : null;
    };
    const daysOut: UsageDay[] = rows.map((r) => ({
      day: r.day, agent: r.agent, model: r.model, input: r.input, output: r.output, cacheRead: r.cr, cacheWrite: r.cw,
      costUsd: cost(r.model, r.input, r.output, r.cr, r.cw),
    }));
    const weekSince = localDay(Date.now() - 6 * 86_400_000);
    const projRows = this.db.prepare(`select project, agent, model, sum(input) as input, sum(output) as output, sum(cache_read) as cr, sum(cache_write) as cw
      from usage_msgs where day >= ? group by project, agent, model`).all(weekSince) as {
      project: string; agent: 'claude' | 'codex'; model: string; input: number; output: number; cr: number; cw: number;
    }[];
    const byProj = new Map<string, { project: string; agent: 'claude' | 'codex'; tokens: number; costUsd: number | null }>();
    for (const r of projRows) {
      const project = this.projectResolver?.(r.project) ?? r.project;
      const k = `${r.agent}:${project}`;
      const cur = byProj.get(k) ?? { project, agent: r.agent, tokens: 0, costUsd: 0 };
      cur.tokens += r.input + r.output + r.cr + r.cw;
      const c = cost(r.model, r.input, r.output, r.cr, r.cw);
      cur.costUsd = c === null || cur.costUsd === null ? cur.costUsd : cur.costUsd + c;
      byProj.set(k, cur);
    }
    return {
      limits: { claude: claudeLimits, codex: this.codexLimits },
      days: daysOut,
      topProjects: [...byProj.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12),
      indexing: this.progress,
      pricingSource: this.pricingSource,
      pulse: this.pulse(daysOut),
    };
  }

  /** Live numbers the daemon knows outside the index (tool calls per minute, sessions working now). */
  live: () => { liveToolCallsPerMin: number; workingNow: number } = () => ({ liveToolCallsPerMin: 0, workingNow: 0 });

  private pulse(days: UsageDay[]): Pulse {
    const today = localDay(Date.now());
    const tok = (d: UsageDay) => d.input + d.output + d.cacheRead + d.cacheWrite;
    const byDay = new Map<string, { tokens: number; cost: number | null }>();
    const mix = new Map<string, number>();
    let cacheRead = 0;
    let allIn = 0;
    let saved: number | null = 0;
    for (const d of days) {
      const cur = byDay.get(d.day) ?? { tokens: 0, cost: 0 };
      cur.tokens += tok(d);
      cur.cost = cur.cost === null || d.costUsd === null ? cur.cost : cur.cost + d.costUsd;
      byDay.set(d.day, cur);
      mix.set(d.model, (mix.get(d.model) ?? 0) + tok(d));
      cacheRead += d.cacheRead;
      allIn += d.input + d.cacheRead + d.cacheWrite;
      const p = this.price(d.model);
      if (p && saved !== null) saved += d.cacheRead * (p.input - p.cacheRead);
    }
    const spark: Pulse['spark'] = [];
    for (let i = 29; i >= 0; i--) {
      const day = localDay(Date.now() - i * 86_400_000);
      const v = byDay.get(day);
      spark.push({ day, tokens: v?.tokens ?? 0, costUsd: v?.cost ?? (v ? null : 0) });
    }
    const active = spark.filter((s) => s.tokens > 0);
    let streak = 0;
    for (let i = spark.length - 1; i >= 0; i--) {
      if (spark[i]!.tokens > 0) streak++;
      else if (i === spark.length - 1) continue; // today may not have started yet
      else break;
    }
    const t = byDay.get(today);
    const todayRows = days.filter((d) => d.day === today);
    const since30 = localDay(Date.now() - 29 * 86_400_000);
    const servers = this.recentServers(60);
    const pretty = (tool: string) => {
      if (!tool.startsWith('mcp:')) return tool;
      const server = tool.slice(4);
      if (server.startsWith('claude_ai_')) return `${server.slice(10).replace(/_/g, ' ')} (MCP)`;
      if (/^[0-9a-f]{8}-/.test(server)) return `${nameFromTool(servers.get(server)?.sample ?? null) ?? 'connector'} (MCP)`;
      return `${server} (MCP)`;
    };
    const tools = (from: string, to: string, n: number) =>
      (this.db.prepare('select tool, sum(calls) as calls from tool_day where day >= ? and day <= ? group by tool order by calls desc limit ?')
        .all(from, to, n) as { tool: string; calls: number }[]).map((t) => ({ ...t, tool: pretty(t.tool) }));
    const toolCallsToday = (this.db.prepare('select coalesce(sum(calls), 0) as n from tool_day where day = ?').get(today) as { n: number }).n;
    const lines = this.db.prepare('select added from lines_day where day = ?').get(today) as { added: number } | undefined;
    // Concurrency: distinct sessions active in each 10-minute bucket.
    const conc = this.db.prepare(`select day, max(n) as peak from (
        select day, (ts / 600000) as bucket, count(distinct session) as n from usage_msgs where day >= ? and session is not null group by day, bucket
      ) group by day`).all(since30) as { day: string; peak: number }[];
    const peakToday = conc.find((c) => c.day === today)?.peak ?? 0;
    const peakRec = conc.reduce<{ day: string; sessions: number } | null>((best, c) => (!best || c.peak > best.sessions ? { day: c.day, sessions: c.peak } : best), null);
    const sessionsToday = (this.db.prepare('select count(distinct session) as n from usage_msgs where day = ? and session is not null').get(today) as { n: number }).n;
    const hourRows = this.db.prepare('select ts, input + output + cache_read + cache_write as t from usage_msgs where day >= ?').all(since30) as { ts: number; t: number }[];
    const hours = new Array<number>(24).fill(0);
    for (const r of hourRows) hours[new Date(r.ts).getHours()]! += r.t;
    const best = this.db.prepare(`select day, sum(input + output + cache_read + cache_write) as t from usage_msgs group by day order by t desc limit 1`).get() as { day: string; t: number } | undefined;
    const totalCost = active.reduce<number | null>((a, s) => (a === null || s.costUsd === null ? a : a + s.costUsd), 0);
    return {
      today: {
        tokens: t?.tokens ?? 0, costUsd: t?.cost ?? 0, outputTokens: todayRows.reduce((a, d) => a + d.output, 0),
        toolCalls: toolCallsToday, linesWritten: lines?.added ?? 0, sessions: sessionsToday, peakConcurrent: peakToday,
      },
      avgDailyTokens: active.length ? active.reduce((a, s) => a + s.tokens, 0) / active.length : 0,
      avgDailyCostUsd: active.length && totalCost !== null ? totalCost / active.length : null,
      streakDays: streak,
      activeDays30: active.length,
      cacheHitPct: allIn ? Math.round((cacheRead / allIn) * 1000) / 10 : null,
      cacheSavedUsd: saved,
      topToolsToday: tools(today, today, 6),
      topTools30: tools(since30, today, 10),
      hours,
      spark,
      modelMix: [...mix.entries()].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, 6),
      records: { bestDay: best ? { day: best.day, tokens: best.t } : null, peakConcurrent: peakRec },
      ...this.live(),
    };
  }
}
