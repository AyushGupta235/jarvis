import { describe, expect, it } from 'vitest';
import type { RichEnvelope, RichEvent } from '@jarvis/protocol';
import { foldThinking } from '../src/renderer/src/thinkingFold';

const log = (events: RichEvent[]): RichEnvelope[] => events.map((event, i) => ({ seq: i + 1, ts: 0, event }));
const think = (text: string): RichEvent => ({ kind: 'thinking', text, parentToolUseId: null });
const tool = (id: string): RichEvent => ({ kind: 'tool_start', toolUseId: id, tool: 'Bash', input: {}, parentToolUseId: null });

describe('foldThinking (rich view, Normal density)', () => {
  it('folds thoughts interleaved with tool calls into one stretch until Claude speaks', () => {
    const { groups, folded } = foldThinking(log([
      { kind: 'user', text: 'go' }, think('a'), tool('1'), think('b'), tool('2'), think('c'),
      { kind: 'text', text: 'update', parentToolUseId: null }, think('d'), tool('3'), think('e'),
      { kind: 'turn_end', ok: true, durationMs: 1, costUsd: null, error: null }, { kind: 'user', text: 'again' }, think('f'),
    ]));
    expect([...groups.entries()]).toEqual([[2, ['a', 'b', 'c']], [8, ['d', 'e']], [13, ['f']]]);
    expect([...folded]).toEqual([4, 6, 10]);
  });
  it("a subagent's text doesn't end the stretch", () => {
    const { groups } = foldThinking(log([think('a'), { kind: 'text', text: 'sub', parentToolUseId: 't1' }, think('b')]));
    expect([...groups.values()]).toEqual([['a', 'b']]);
  });
});
