import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentResultTask, readAgentSteps } from '../src/subagents';

describe('agentResultTask', () => {
  it('turns an Agent tool result into the stats a card shows', () => {
    const t = agentResultTask('toolu_1', { status: 'completed', agentId: 'a1b2', agentType: 'Explore', totalToolUseCount: 3, totalTokens: 42000, totalDurationMs: 11000, resolvedModel: 'claude-haiku-5-5' });
    expect(t).toMatchObject({ kind: 'task', taskId: 'a1b2', toolUseId: 'toolu_1', state: 'done', agentType: 'Explore', tools: 3, tokens: 42000, durationMs: 11000, model: 'claude-haiku-5-5' });
    expect(agentResultTask('x', { status: 'completed' })).toBeNull();
    expect(agentResultTask('x', undefined)).toBeNull();
  });
});

describe('readAgentSteps', () => {
  it("reads a sub-agent's calls, results and words from its own transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-sub-'));
    const transcript = join(dir, 'sess.jsonl');
    mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
    const line = (o: unknown) => JSON.stringify(o);
    writeFileSync(join(dir, 'sess', 'subagents', 'agent-abc.jsonl'), [
      line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'the prompt' } }),
      line({ type: 'attachment' }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'one file' }] } }),
    ].join('\n'));
    const ev = await readAgentSteps(transcript, 'abc', 'toolu_parent');
    expect(ev.map((e) => e.kind)).toEqual(['thinking', 'tool_start', 'tool_end', 'text']);
    expect(ev[1]).toMatchObject({ toolUseId: 't1', tool: 'Bash', parentToolUseId: 'toolu_parent' });
    expect(ev[2]).toMatchObject({ toolUseId: 't1', output: 'a.txt', isError: false });
    expect(await readAgentSteps(transcript, 'missing', 'x')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
