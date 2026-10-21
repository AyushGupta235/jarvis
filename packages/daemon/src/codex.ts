import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Observers } from './observers';
import { readNewLines } from './jsonl';

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function dayDirs(root: string): string[] {
  const out: string[] = [];
  for (const back of [0, 1]) {
    const d = new Date(Date.now() - back * 86_400_000);
    const p = join(root, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (existsSync(p)) out.push(p);
  }
  return out;
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('');
  return content == null ? '' : JSON.stringify(content);
}

interface Bound { file: string; offset: number }

/**
 * Follows the rollout log of each Codex session Jarvis launched (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 * and turns it into the same state and activity as Claude's hooks. Read-only; Codex keeps its own TUI.
 */
export class CodexObserver {
  private pending = new Map<string, { cwd: string; since: number }>();
  private bound = new Map<string, Bound>();
  private claimed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly obs: Observers, private readonly root = codexHome()) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 1500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  track(id: string, cwd: string, since: number): void {
    if (!this.bound.has(id)) this.pending.set(id, { cwd, since });
  }

  untrack(id: string): void {
    this.pending.delete(id);
    const b = this.bound.get(id);
    if (b) this.claimed.delete(b.file);
    this.bound.delete(id);
  }

  tick(): void {
    if (this.pending.size) this.bindPending();
    for (const [id, b] of this.bound) {
      const { lines, offset } = readNewLines(b.file, b.offset);
      b.offset = offset;
      for (const l of lines) {
        if (!l) continue;
        try {
          this.handle(id, JSON.parse(l));
        } catch { /* partial or foreign line */ }
      }
    }
  }

  private bindPending(): void {
    const files: { path: string; mtime: number }[] = [];
    for (const dir of dayDirs(this.root)) {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
        const p = join(dir, f);
        if (this.claimed.has(p)) continue;
        try {
          files.push({ path: p, mtime: statSync(p).mtimeMs });
        } catch { /* gone */ }
      }
    }
    for (const [id, want] of this.pending) {
      for (const f of files) {
        if (f.mtime < want.since - 5000 || this.claimed.has(f.path)) continue;
        const { lines } = readNewLines(f.path, 0, 1 << 20);
        try {
          const meta = JSON.parse(lines[0] ?? '{}') as { type?: string; payload?: { cwd?: string; timestamp?: string; id?: string } };
          if (meta.type !== 'session_meta' || meta.payload?.cwd !== want.cwd) continue;
          const started = Date.parse(meta.payload.timestamp ?? '');
          if (Number.isFinite(started) && started < want.since - 10_000) continue;
          this.claimed.add(f.path);
          this.bound.set(id, { file: f.path, offset: 0 });
          this.pending.delete(id);
          break;
        } catch { /* unreadable */ }
      }
    }
  }

  handle(id: string, d: { type?: string; timestamp?: string; payload?: Record<string, any> }): void {
    const p = d.payload ?? {};
    const ts = Date.parse(d.timestamp ?? '') || Date.now();
    const base = { sessionId: id, ts, agentId: null, agentType: null, toolUseId: null, tool: null, status: null, durationMs: null, input: null, output: null };
    if (d.type === 'session_meta') {
      if (typeof p.id === 'string') this.obs.emit('agentSessionId', { id, agentSessionId: p.id });
      this.obs.addActivity({ ...base, kind: 'session', summary: `Codex ${p.cli_version ?? ''} session started` });
      return;
    }
    if (d.type === 'turn_context') {
      if (typeof p.model === 'string') this.obs.patch(id, { model: p.effort ? `${p.model} (${p.effort})` : p.model });
      return;
    }
    if (d.type === 'event_msg') {
      switch (p.type) {
        case 'task_started':
          this.obs.setPhase(id, 'working');
          return;
        case 'task_complete':
          if (typeof p.last_agent_message === 'string') {
            this.obs.patch(id, { lastReply: p.last_agent_message });
            this.obs.addActivity({ ...base, kind: 'reply', summary: p.last_agent_message.replace(/\s+/g, ' ').slice(0, 200), output: p.last_agent_message });
          }
          this.obs.setPhase(id, 'done');
          return;
        case 'user_message':
          if (typeof p.message === 'string') {
            this.obs.patch(id, { lastPrompt: p.message });
            this.obs.addActivity({ ...base, kind: 'prompt', summary: p.message.replace(/\s+/g, ' ').slice(0, 200), output: p.message });
          }
          return;
        case 'exec_approval_request':
        case 'apply_patch_approval_request':
        case 'request_user_input':
          this.obs.setPhase(id, 'needs_input', p.type === 'exec_approval_request' ? `Approve: ${text(p.command)}` : 'Codex needs your input');
          return;
        case 'token_count': {
          const info = p.info;
          if (info?.last_token_usage) {
            const used = info.last_token_usage.input_tokens ?? 0;
            const win = info.model_context_window ?? null;
            this.obs.patch(id, { context: { usedTokens: used, windowTokens: win, usedPct: win ? Math.round((used / win) * 1000) / 10 : null } });
          }
          return;
        }
      }
      return;
    }
    if (d.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        const name = String(p.name ?? p.type);
        const input = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : JSON.stringify(p.action ?? {});
        const summary = input.replace(/\s+/g, ' ').slice(0, 140);
        this.obs.addActivity({ ...base, kind: 'tool', tool: name, toolUseId: String(p.call_id ?? p.id ?? ts), status: 'running', summary, input });
        if (this.obs.state(id)?.phase !== 'working') this.obs.setPhase(id, 'working');
        this.obs.patch(id, { tool: `${name}: ${summary.slice(0, 80)}`, toolCalls: (this.obs.state(id)?.toolCalls ?? 0) + 1 });
        return;
      }
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        this.obs.finishTool(id, String(p.call_id), 'ok', null, text(p.output));
      }
    }
  }
}
