import { EventEmitter } from 'node:events';
import { relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ActivityEntry, ActivityKind, AgentLiveState, AgentPhase } from '@jarvis/protocol';

const MAX_INPUT = 16_000;
const MAX_OUTPUT = 32_000;
const KEEP_PER_SESSION = 4000;

function trunc(s: string | null | undefined, n: number): string | null {
  if (s == null) return null;
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s;
}

function oneLine(s: string, n = 140): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Human summary of a tool call: the part you'd want to see in a timeline row. */
export function toolSummary(tool: string, input: unknown, cwd: string | null): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const rel = (p: string) => (cwd && p.startsWith(cwd + '/') ? relative(cwd, p) : p);
  if (tool === 'Bash') return oneLine(str('command').split('\n')[0] ?? '');
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return rel(str('file_path') || str('notebook_path'));
  if (tool === 'Grep') return oneLine(`${str('pattern')}${str('path') ? `  in ${rel(str('path'))}` : ''}`);
  if (tool === 'Glob') return str('pattern');
  if (tool === 'Agent' || tool === 'Task') return oneLine(`${str('subagent_type') || 'agent'}: ${str('description') || str('prompt')}`);
  if (tool === 'WebFetch') return str('url');
  if (tool === 'WebSearch') return str('query');
  if (tool === 'Skill') return str('skill');
  if (tool.startsWith('mcp__')) {
    const [, rawServer, name] = tool.split('__');
    const server = (rawServer ?? '').replace(/^claude_ai_/, '').replace(/_/g, ' ');
    const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
    return oneLine(`${server} · ${name}${first ? ` ${first}` : ''}`);
  }
  const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
  return oneLine(first ?? '');
}

function outputText(resp: unknown, tool?: string | null, input?: unknown): string | null {
  // Edits read best as a diff: use the structured patch Claude returns, else old/new strings from the input.
  if (tool && ['Edit', 'MultiEdit', 'Write'].includes(tool)) {
    const r = (resp && typeof resp === 'object' ? resp : {}) as Record<string, unknown>;
    const patch = r.structuredPatch as { oldStart: number; newStart: number; lines: string[] }[] | undefined;
    if (Array.isArray(patch) && patch.length) {
      return patch.map((h) => [`@@ -${h.oldStart} +${h.newStart} @@`, ...h.lines].join('\n')).join('\n');
    }
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (typeof i.old_string === 'string' && typeof i.new_string === 'string') {
      return [...i.old_string.split('\n').map((l) => `-${l}`), ...i.new_string.split('\n').map((l) => `+${l}`)].join('\n');
    }
    if (tool === 'Write' && typeof i.content === 'string') return i.content.split('\n').map((l) => `+${l}`).join('\n');
  }
  if (resp == null) return null;
  if (typeof resp === 'string') return resp;
  if (typeof resp === 'object') {
    const r = resp as Record<string, unknown>;
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      return [r.stdout, r.stderr ? `\n[stderr]\n${r.stderr}` : ''].filter(Boolean).join('');
    }
    const file = r.file as Record<string, unknown> | undefined;
    if (file && typeof file.content === 'string') return file.content;
  }
  return JSON.stringify(resp, null, 2);
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function emptyState(): AgentLiveState {
  return {
    phase: 'idle', since: Date.now(), message: null, tool: null, title: null, model: null, context: null,
    costUsd: null, linesAdded: null, linesRemoved: null, subagentsRunning: 0, toolCalls: 0, lastPrompt: null, lastReply: null,
  };
}

interface Row {
  id: number; session_id: string; ts: number; kind: string; tool_use_id: string | null; tool: string | null;
  agent_id: string | null; agent_type: string | null; status: string | null; duration_ms: number | null;
  summary: string; input: string | null; output: string | null;
}

function toEntry(r: Row): ActivityEntry {
  return {
    id: r.id, sessionId: r.session_id, ts: r.ts, kind: r.kind as ActivityKind, toolUseId: r.tool_use_id, tool: r.tool,
    agentId: r.agent_id, agentType: r.agent_type, status: r.status as ActivityEntry['status'], durationMs: r.duration_ms,
    summary: r.summary, input: r.input, output: r.output,
  };
}

/**
 * Per-session live state and activity log, fed by read-only observers (Claude hooks + status line,
 * Codex rollout logs). Emits 'state', 'activity', 'attention' and 'agentSessionId'.
 */
export class Observers extends EventEmitter {
  private states = new Map<string, AgentLiveState>();
  private cwd = new Map<string, string>();
  /** Plan limits read from a rich session (the SDK reports them each turn). Older readings never replace newer ones. */
  setClaudeLimits(r: { at: number; fiveHour: { usedPct: number; resetsAt: number | null } | null; sevenDay: { usedPct: number; resetsAt: number | null } | null }): void {
    if (this.claudeLimits.asOf && r.at <= this.claudeLimits.asOf) return;
    this.claudeLimits = {
      fiveHour: r.fiveHour ?? this.claudeLimits.fiveHour,
      sevenDay: r.sevenDay ?? this.claudeLimits.sevenDay,
      asOf: r.at,
    };
    this.emit('limits');
  }

  /** Latest Claude plan limits seen, in a terminal session's status line or a rich session's SDK events. */
  claudeLimits: { fiveHour: { usedPct: number; resetsAt: number | null } | null; sevenDay: { usedPct: number; resetsAt: number | null } | null; asOf: number | null } =
    { fiveHour: null, sevenDay: null, asOf: null };

  constructor(private readonly db: DatabaseSync) {
    super();
  }

  state(id: string): AgentLiveState | null {
    return this.states.get(id) ?? null;
  }

  setCwd(id: string, cwd: string): void {
    this.cwd.set(id, cwd);
  }

  forget(id: string): void {
    this.states.delete(id);
  }

  private st(id: string): AgentLiveState {
    let s = this.states.get(id);
    if (!s) {
      s = emptyState();
      this.states.set(id, s);
    }
    return s;
  }

  setPhase(id: string, phase: AgentPhase, message: string | null = null): void {
    const s = this.st(id);
    const changed = s.phase !== phase || s.message !== message;
    if (s.phase !== phase) s.since = Date.now();
    s.phase = phase;
    s.message = message;
    if (phase !== 'working') s.tool = null;
    if (changed) {
      this.emit('state', id);
      if (phase === 'needs_input' || phase === 'done') this.emit('attention', { sessionId: id, phase, message });
    }
  }

  patch(id: string, p: Partial<AgentLiveState>): void {
    Object.assign(this.st(id), p);
    this.emit('state', id);
  }

  // ---------- activity store ----------

  addActivity(e: Omit<ActivityEntry, 'id'>): ActivityEntry {
    const r = this.db
      .prepare(`insert into events (session_id, ts, kind, tool_use_id, tool, agent_id, agent_type, status, duration_ms, summary, input, output)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (session_id, tool_use_id) where tool_use_id is not null do update set
          status = coalesce(excluded.status, status), duration_ms = coalesce(excluded.duration_ms, duration_ms),
          output = coalesce(excluded.output, output), input = coalesce(input, excluded.input)
        returning *`)
      .get(e.sessionId, e.ts, e.kind, e.toolUseId, e.tool, e.agentId, e.agentType, e.status, e.durationMs, e.summary,
        trunc(e.input, MAX_INPUT), trunc(e.output, MAX_OUTPUT)) as unknown as Row;
    const entry = toEntry(r);
    this.emit('activity', entry);
    return entry;
  }

  finishTool(sessionId: string, toolUseId: string, status: 'ok' | 'error', durationMs: number | null, output: string | null): ActivityEntry | null {
    const r = this.db
      .prepare(`update events set status = ?, duration_ms = coalesce(?, duration_ms), output = coalesce(?, output)
        where session_id = ? and tool_use_id = ? returning *`)
      .get(status, durationMs, trunc(output, MAX_OUTPUT), sessionId, toolUseId) as unknown as Row | undefined;
    if (!r) return null;
    const entry = toEntry(r);
    this.emit('activity', entry);
    return entry;
  }

  list(sessionId: string, limit = 400): ActivityEntry[] {
    const rows = this.db.prepare('select * from events where session_id = ? order by id desc limit ?').all(sessionId, limit) as unknown as Row[];
    return rows.reverse().map(toEntry);
  }

  /** Files the agent wrote or edited in this session, most recent first. */
  touched(sessionId: string): string[] {
    const rows = this.db
      .prepare(`select input from events where session_id = ? and kind = 'tool' and tool in ('Write','Edit','MultiEdit','NotebookEdit') order by id desc limit 2000`)
      .all(sessionId) as { input: string | null }[];
    const seen = new Set<string>();
    for (const r of rows) {
      try {
        const i = JSON.parse(r.input ?? '{}') as { file_path?: string; notebook_path?: string; path?: string };
        const p = i.file_path ?? i.notebook_path ?? i.path;
        if (p) seen.add(p);
      } catch { /* truncated input */ }
    }
    return [...seen];
  }

  prune(): void {
    this.db.exec(`delete from events where id in (
      select id from (select id, row_number() over (partition by session_id order by id desc) as rn from events) where rn > ${KEEP_PER_SESSION})`);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('delete from events where session_id = ?').run(sessionId);
    this.states.delete(sessionId);
  }

  // ---------- Claude Code ----------

  claudeHook(id: string, ev: Record<string, unknown>): void {
    const name = String(ev.hook_event_name ?? '');
    const now = Date.now();
    const s = this.st(id);
    const cwd = (typeof ev.cwd === 'string' ? ev.cwd : null) ?? this.cwd.get(id) ?? null;
    const agentId = typeof ev.agent_id === 'string' ? ev.agent_id : null;
    const agentType = typeof ev.agent_type === 'string' ? ev.agent_type : null;
    const tool = typeof ev.tool_name === 'string' ? ev.tool_name : null;
    const toolUseId = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : null;
    const base = { sessionId: id, ts: now, agentId, agentType, toolUseId: null, tool: null, status: null, durationMs: null, input: null, output: null };

    switch (name) {
      case 'SessionStart':
        if (typeof ev.session_id === 'string') this.emit('agentSessionId', { id, agentSessionId: ev.session_id });
        this.addActivity({ ...base, kind: 'session', summary: `Session ${String(ev.source ?? 'start')}` });
        this.setPhase(id, 'idle');
        return;
      case 'UserPromptSubmit': {
        const prompt = String(ev.prompt ?? '');
        s.lastPrompt = prompt;
        this.addActivity({ ...base, kind: 'prompt', summary: oneLine(prompt, 200), output: prompt });
        this.setPhase(id, 'working');
        return;
      }
      case 'PreToolUse': {
        if (!tool) return;
        const summary = toolSummary(tool, ev.tool_input, cwd);
        s.toolCalls++;
        this.addActivity({ ...base, kind: 'tool', tool, toolUseId, status: 'running', summary, input: JSON.stringify(ev.tool_input ?? {}, null, 2) });
        if (!agentId) {
          s.tool = `${tool}${summary ? `: ${summary}` : ''}`;
          if (s.phase !== 'working') this.setPhase(id, 'working');
          s.tool = `${tool}${summary ? `: ${summary}` : ''}`;
          this.emit('state', id);
        }
        return;
      }
      case 'PermissionRequest': {
        const summary = tool ? `${tool}${ev.tool_input ? `: ${toolSummary(tool, ev.tool_input, cwd)}` : ''}` : 'permission';
        this.setPhase(id, 'needs_input', `Permission: ${summary}`);
        return;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const ok = name === 'PostToolUse';
        const out = ok ? outputText(ev.tool_response, tool, ev.tool_input) : String(ev.error ?? outputText(ev.tool_response) ?? 'failed');
        const dur = typeof ev.duration_ms === 'number' ? ev.duration_ms : null;
        const done = toolUseId ? this.finishTool(id, toolUseId, ok ? 'ok' : 'error', dur, out) : null;
        if (!done && tool) {
          this.addActivity({ ...base, kind: 'tool', tool, toolUseId, status: ok ? 'ok' : 'error', durationMs: dur,
            summary: toolSummary(tool, ev.tool_input, cwd), input: JSON.stringify(ev.tool_input ?? {}, null, 2), output: out });
        }
        if (tool && EDIT_TOOLS.has(tool)) this.emit('fileEdited', { id, cwd });
        if (s.phase === 'needs_input') this.setPhase(id, 'working');
        return;
      }
      case 'Notification': {
        const type = String(ev.notification_type ?? '');
        const msg = typeof ev.message === 'string' ? ev.message : null;
        this.addActivity({ ...base, kind: 'notification', summary: oneLine(msg ?? type, 200), output: msg });
        if (['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(type)) {
          this.setPhase(id, 'needs_input', msg);
        }
        return;
      }
      case 'Stop':
      case 'StopFailure': {
        if (agentId) return;
        const reply = typeof ev.last_assistant_message === 'string' ? ev.last_assistant_message : null;
        s.lastReply = reply;
        if (reply) this.addActivity({ ...base, kind: 'reply', summary: oneLine(reply, 200), output: reply });
        this.setPhase(id, 'done', name === 'StopFailure' ? String(ev.error ?? 'Turn failed') : null);
        return;
      }
      case 'SubagentStart':
        if (!agentType) return; // Claude's own internal helpers (e.g. prompt suggestions) carry no type
        s.subagentsRunning++;
        this.addActivity({ ...base, kind: 'subagent', status: 'running', summary: `${agentType ?? 'subagent'} started` });
        this.emit('state', id);
        return;
      case 'SubagentStop':
        if (!agentType) return;
        s.subagentsRunning = Math.max(0, s.subagentsRunning - 1);
        this.addActivity({ ...base, kind: 'subagent', status: 'ok', summary: `${agentType ?? 'subagent'} finished`,
          output: typeof ev.last_assistant_message === 'string' ? ev.last_assistant_message : null });
        this.emit('state', id);
        return;
      case 'PreCompact':
        this.addActivity({ ...base, kind: 'compact', summary: `Compacting (${String(ev.trigger ?? 'manual')})` });
        this.setPhase(id, 'compacting');
        return;
      case 'PostCompact':
        this.setPhase(id, 'idle');
        return;
      case 'PostModelSwitch':
        if (typeof ev.model === 'string') this.patch(id, { model: ev.model });
        return;
      case 'SessionEnd':
        this.addActivity({ ...base, kind: 'session', summary: `Session ended (${String(ev.reason ?? '')})` });
        this.setPhase(id, 'idle');
        return;
    }
  }

  claudeStatus(id: string, j: Record<string, any>): void {
    const s = this.st(id);
    const cw = j.context_window ?? {};
    const used = typeof cw.used_percentage === 'number' ? cw.used_percentage : null;
    const win = typeof cw.context_window_size === 'number' ? cw.context_window_size : null;
    const cu = cw.current_usage ?? {};
    const usedTokens = typeof cu.input_tokens === 'number'
      ? (cu.input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0)
      : (used !== null && win ? Math.round((used / 100) * win) : null);
    s.context = { usedPct: used, usedTokens, windowTokens: win };
    s.model = j.model?.display_name ?? j.model?.id ?? s.model;
    s.costUsd = typeof j.cost?.total_cost_usd === 'number' ? j.cost.total_cost_usd : s.costUsd;
    s.linesAdded = j.cost?.total_lines_added ?? s.linesAdded;
    s.linesRemoved = j.cost?.total_lines_removed ?? s.linesRemoved;
    s.title = typeof j.session_name === 'string' ? j.session_name : s.title;
    const rl = j.rate_limits;
    if (rl) {
      const win5 = rl.five_hour;
      const win7 = rl.seven_day;
      this.claudeLimits = {
        fiveHour: win5 ? { usedPct: win5.used_percentage, resetsAt: win5.resets_at ? win5.resets_at * 1000 : null } : this.claudeLimits.fiveHour,
        sevenDay: win7 ? { usedPct: win7.used_percentage, resetsAt: win7.resets_at ? win7.resets_at * 1000 : null } : this.claudeLimits.sevenDay,
        asOf: Date.now(),
      };
      this.emit('limits');
    }
    this.emit('state', id);
  }
}
