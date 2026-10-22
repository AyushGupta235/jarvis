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
});
