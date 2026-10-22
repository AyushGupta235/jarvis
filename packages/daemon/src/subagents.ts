import { createReadStream, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RichEvent } from '@jarvis/protocol';

type TaskEvent = Extract<RichEvent, { kind: 'task' }>;

/**
 * Claude records what a sub-agent did in the result of the Agent tool call: its id, type, model, and totals.
 * This turns that into the same `task` event the live stream produces, so a card opened after a restart has them.
 */
export function agentResultTask(toolUseId: string, r: Record<string, any> | undefined): TaskEvent | null {
  if (!r || typeof r.agentId !== 'string') return null;
  const status = String(r.status ?? '');
  return {
    kind: 'task', taskId: r.agentId, toolUseId, state: status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'running' || status === 'async_launched' ? 'running' : 'stopped',
    description: null, agentType: typeof r.agentType === 'string' ? r.agentType : null,
    tools: typeof r.totalToolUseCount === 'number' ? r.totalToolUseCount : null, tokens: typeof r.totalTokens === 'number' ? r.totalTokens : null,
    durationMs: typeof r.totalDurationMs === 'number' ? r.totalDurationMs : null, lastTool: null, progress: null, background: status === 'async_launched',
    model: typeof r.resolvedModel === 'string' ? r.resolvedModel : null,
  };
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('') : '';

/** Where Claude keeps a sub-agent's own transcript, next to the session's. */
export function subagentPath(transcript: string, agentId: string): string {
  return join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`);
}

/**
 * The steps a sub-agent took, from its own transcript: its tool calls and their results, what it said, and (for a
 * sub-agent that spawned more) their results. Events carry `parentToolUseId` so they slot under its card.
 */
export async function readAgentSteps(transcript: string, agentId: string, toolUseId: string, limit = 600): Promise<RichEvent[]> {
  const path = subagentPath(transcript, agentId);
  if (!existsSync(path)) return [];
  const out: RichEvent[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if ((r.type !== 'user' && r.type !== 'assistant') || !r.message || r.isMeta) continue;
    const content = r.message.content;
    if (r.type === 'user') {
      if (typeof content === 'string') {
        first = false; // its prompt (shown on the card already) and harness reminders
        continue;
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'tool_result') {
          out.push({ kind: 'tool_end', toolUseId: b.tool_use_id, output: textOf(b.content).slice(0, 20_000), isError: !!b.is_error });
          const t = agentResultTask(b.tool_use_id, r.toolUseResult);
          if (t) out.push(t);
        }
      }
      continue;
    }
    first = false;
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'text' && b.text) out.push({ kind: 'text', text: b.text, parentToolUseId: toolUseId });
      else if (b?.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking, parentToolUseId: toolUseId });
      else if (b?.type === 'tool_use') out.push({ kind: 'tool_start', toolUseId: b.id, tool: b.name, input: b.input ?? null, parentToolUseId: toolUseId });
    }
  }
  void first;
  return out.slice(-limit);
}

/**
 * What an agent that was launched in the background did, counted from its own transcript: Claude does not record
 * totals for it. Tokens are left out because they cannot be added up from the per-message numbers reliably.
 */
export async function agentStatsFromTranscript(transcript: string, agentId: string): Promise<{ tools: number; durationMs: number | null } | null> {
  const path = subagentPath(transcript, agentId);
  if (!existsSync(path)) return null;
  let tools = 0;
  let first: number | null = null;
  let last: number | null = null;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      first ??= ts;
      last = ts;
    }
    if (r.type === 'assistant') for (const b of Array.isArray(r.message?.content) ? r.message.content : []) if (b?.type === 'tool_use' && b.name !== 'SubagentHandback') tools++;
  }
  return { tools, durationMs: first != null && last != null ? last - first : null };
}
