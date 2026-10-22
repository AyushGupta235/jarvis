import type { RichEnvelope } from '@jarvis/protocol';

/**
 * Stretches of thinking between two messages (your prompt, a reply from Claude, the end of a turn), for the
 * rich view's Normal density: `groups` maps the first thought of each stretch to all of its thoughts, and
 * `folded` holds the later thoughts, which render nothing. Tool calls don't break a stretch.
 */
export function foldThinking(events: RichEnvelope[]): { groups: Map<number, string[]>; folded: Set<number> } {
  const groups = new Map<number, string[]>();
  const folded = new Set<number>();
  let cur: string[] | null = null;
  for (const { seq, event: e } of events) {
    if (e.kind === 'thinking') {
      if (e.parentToolUseId) continue; // a sub-agent's thinking is drawn inside its card
      if (cur) folded.add(seq);
      else groups.set(seq, (cur = []));
      cur.push(e.text);
    } else if (e.kind === 'user' || e.kind === 'turn_end' || (e.kind === 'text' && !e.parentToolUseId)) {
      cur = null;
    }
  }
  return { groups, folded };
}
