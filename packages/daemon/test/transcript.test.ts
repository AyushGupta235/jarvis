import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChain } from '../src/transcript';

const row = (o: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-10-21T10:00:00Z', ...o });
const user = (uuid: string, parent: string | null, text: string, extra = {}) => row({ type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: text }, ...extra });
const asst = (uuid: string, parent: string, text: string) => row({ type: 'assistant', uuid, parentUuid: parent, message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('readChain', () => {
  it('follows the live branch across a compaction, skips abandoned branches, subagents and command echoes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-chain-'));
    const f = join(dir, 's.jsonl');
    writeFileSync(f, [
      user('u1', null, 'first question'), asst('a1', 'u1', 'first answer'),
      user('u2', 'a1', 'abandoned branch prompt'), asst('a2', 'u2', 'abandoned answer'),   // a rewind went back to a1
      user('u3', 'a1', 'second question'), asst('a3', 'u3', 'second answer'),
      row({ type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'a3' }),
      user('u4', 'c1', 'after compaction'),
      user('u5', 'u4', '<command-name>/model</command-name>'),
      row({ type: 'assistant', uuid: 'sub1', parentUuid: 'u4', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }),
      asst('a4', 'u5', 'latest answer'),
    ].join('\n'));
    const c = await readChain(f);
    expect(c.entries.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u3', 'a3', 'c1', 'u4', 'u5', 'a4']);
    expect(c.prompts.map((p) => p.text)).toEqual(['first question', 'second question', 'after compaction']);
    expect(c.prompts[1]).toMatchObject({ uuid: 'u3', before: 'a1' }); // rewinding to before "second question" forks at a1
    expect(c.prompts[2]!.before).toBe('a3');                           // a compaction marker is not a fork point
    expect((await readChain(f, 3)).entries.map((e) => e.uuid)).toEqual(['u4', 'u5', 'a4']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every call and result of parallel tool calls, though only one of them is on the parent chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-chain-'));
    const f = join(dir, 's.jsonl');
    const at = (n: number) => ({ timestamp: `2026-10-21T10:00:${String(n).padStart(2, '0')}Z` });
    const call = (uuid: string, parent: string, id: string, n: number) => row({ type: 'assistant', uuid, parentUuid: parent, ...at(n), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] } });
    const result = (uuid: string, parent: string, id: string, n: number) => row({ type: 'user', uuid, parentUuid: parent, ...at(n), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'r' }] }, toolUseResult: { agentId: `agent-${id}` } });
    writeFileSync(f, [
      // a call from a branch that was rewound away: it hangs off nothing on the live path
      user('x1', null, 'abandoned'), call('x2', 'x1', 'tz', 0),
      user('u1', null, 'go'),
      call('a1', 'u1', 'ta', 1), call('a2', 'a1', 'tb', 2), call('a3', 'a2', 'tc', 3),
      result('r3', 'a3', 'tc', 4), result('r1', 'a1', 'ta', 5), result('r2', 'a2', 'tb', 6),
      asst('done', 'r2', 'all finished'),
    ].join('\n').replace(/"timestamp":"2026-10-21T10:00:00Z"/g, '"timestamp":"2026-10-21T10:00:08Z"'));
    const c = await readChain(f);
    const ids = c.entries.map((e) => e.uuid);
    for (const u of ['a1', 'a2', 'a3', 'r1', 'r2', 'r3']) expect(ids).toContain(u);
    expect(ids).not.toContain('x2');
    expect(c.entries.find((e) => e.uuid === 'r1')?.toolUseResult).toEqual({ agentId: 'agent-ta' });
    // results come after their calls
    expect(ids.indexOf('r1')).toBeGreaterThan(ids.indexOf('a1'));
    expect(ids.indexOf('r3')).toBeGreaterThan(ids.indexOf('a3'));
    rmSync(dir, { recursive: true, force: true });
  });
});
