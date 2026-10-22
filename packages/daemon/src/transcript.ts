import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface ChainEntry {
  uuid: string;
  type: 'user' | 'assistant' | 'compact';
  message?: any;
  parentToolUseId: string | null;
  ts: number | null;
}

export interface Chain {
  /** The whole conversation in order, across every compaction (newest last). */
  entries: ChainEntry[];
  /** Your real prompts (not tool results or command echoes), newest last, with the message to fork at to rewind to just before each. */
  prompts: { uuid: string; text: string; ts: number | null; before: string | null }[];
  /** How many entries the conversation has in total (entries may be trimmed to the newest `limit`). */
  total: number;
}

const COMMAND_ECHO = /^<(command-|local-command|system-reminder|task-notification)/;

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return COMMAND_ECHO.test(content) ? null : content;
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return null;
  const t = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return t && !COMMAND_ECHO.test(t) ? t : null;
}

/**
 * Claude's own transcript (~/.claude/projects/.../<id>.jsonl) as one conversation. Each entry points at its parent
 * (`parentUuid`, or `logicalParentUuid` across a compaction), so walking back from the newest message gives the
 * live branch and skips branches a rewind abandoned. Unlike the SDK's getSessionMessages, this does not stop at the
 * last compaction: you keep seeing the whole conversation, with a marker where each compaction happened.
 * Streams the file (they reach 100 MB) and keeps only what the walk needs.
 */
export async function readChain(path: string, limit = 2500): Promise<Chain> {
  const parent = new Map<string, string | null>();
  const keep = new Map<string, ChainEntry & { isMeta?: boolean }>();
  let newest: string | null = null;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"uuid"')) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r.uuid || r.isSidechain) continue;
    parent.set(r.uuid, r.parentUuid ?? r.logicalParentUuid ?? null);
    const ts = r.timestamp ? Date.parse(r.timestamp) : null;
    if (r.type === 'user' || r.type === 'assistant') {
      keep.set(r.uuid, { uuid: r.uuid, type: r.type, message: r.message, parentToolUseId: r.parent_tool_use_id ?? null, ts, isMeta: !!r.isMeta });
      newest = r.uuid;
    } else if (r.type === 'system' && r.subtype === 'compact_boundary') {
      keep.set(r.uuid, { uuid: r.uuid, type: 'compact', parentToolUseId: null, ts });
    }
  }
  const walked: string[] = [];
  const seen = new Set<string>();
  for (let u: string | null = newest; u && !seen.has(u); u = parent.get(u) ?? null) {
    seen.add(u);
    if (keep.has(u)) walked.push(u);
  }
  walked.reverse();
  const all = walked.map((u) => keep.get(u)!).filter((e) => !(e as { isMeta?: boolean }).isMeta);
  const prompts: Chain['prompts'] = [];
  let lastMessage: string | null = null;
  for (const e of all) {
    if (e.type === 'user') {
      const text = promptText(e.message?.content);
      if (text) prompts.push({ uuid: e.uuid, text, ts: e.ts, before: lastMessage });
    }
    if (e.type !== 'compact') lastMessage = e.uuid;
  }
  return { entries: all.slice(-limit), prompts, total: all.length };
}
