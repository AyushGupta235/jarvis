import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ThinkingEntry, ThinkingList } from '@jarvis/protocol';

/** ~/.claude/projects/<encoded cwd>/<id>.jsonl, wherever Claude filed it. */
export function findTranscript(agentSessionId: string, claudeHome = join(homedir(), '.claude')): string | null {
  const root = join(claudeHome, 'projects');
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, `${agentSessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch { /* no projects dir */ }
  return null;
}

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === 'tool_result')) return null;
  const t = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return t || null;
}

/**
 * The thinking in a Claude transcript, oldest first, each with the prompt it was answering. Reads the file
 * line by line (transcripts reach 100 MB) and only parses lines that can matter. Keeps the newest `limit`.
 */
export async function readThinking(path: string | null, limit = 400): Promise<ThinkingList> {
  if (!path) return { entries: [], omitted: 0, transcript: null };
  const entries: ThinkingEntry[] = [];
  let omitted = 0;
  let prompt: string | null = null;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const isUser = line.includes('"type":"user"');
    if (!isUser && !line.includes('"thinking"')) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === 'user' && !r.isMeta && !r.isSidechain) {
      const p = promptText(r.message?.content);
      if (p && !p.startsWith('<command-') && !p.startsWith('<local-command')) prompt = p;
      continue;
    }
    if (r.type !== 'assistant' || r.isSidechain) continue;
    for (const b of r.message?.content ?? []) {
      if (b?.type !== 'thinking') continue;
      const text = String(b.thinking ?? '').trim();
      if (!text) {
        omitted++;
        continue;
      }
      entries.push({ ts: r.timestamp ? Date.parse(r.timestamp) : null, prompt, text, model: r.message?.model ?? null });
      if (entries.length > limit) entries.shift();
    }
  }
  return { entries, omitted, transcript: path };
}
