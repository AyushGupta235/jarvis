import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db';
import { Observers, toolSummary } from '../src/observers';
import { CodexObserver } from '../src/codex';
import { parseAccounts, pickBranchPr } from '../src/prs';
import type { PullRequest } from '@jarvis/protocol';
import { projectOf } from '../src/usage';

function setup() {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'jarvis-obs-')), 'j.db'));
  const obs = new Observers(db.raw);
  const attention: string[] = [];
  obs.on('attention', (a: { phase: string }) => attention.push(a.phase));
  return { db, obs, attention };
}

const ev = (name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: 'cs-1', cwd: '/repo', ...extra });

describe('Claude hook state machine', () => {
  it('tracks a turn: prompt, tool call, permission, finish', () => {
    const { obs, attention } = setup();
    obs.claudeHook('s1', ev('SessionStart', { source: 'startup' }));
    expect(obs.state('s1')?.phase).toBe('idle');
    obs.claudeHook('s1', ev('UserPromptSubmit', { prompt: 'run the tests' }));
    expect(obs.state('s1')?.phase).toBe('working');
    obs.claudeHook('s1', ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } }));
    expect(obs.state('s1')?.tool).toBe('Bash: npm test');
    obs.claudeHook('s1', ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    expect(obs.state('s1')?.phase).toBe('needs_input');
    expect(obs.state('s1')?.message).toBe('Permission: Bash: npm test');
    obs.claudeHook('s1', ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_response: { stdout: 'ok', stderr: '' }, duration_ms: 1200 }));
    expect(obs.state('s1')?.phase).toBe('working');
    obs.claudeHook('s1', ev('Stop', { last_assistant_message: 'All tests pass.' }));
    expect(obs.state('s1')?.phase).toBe('done');
    expect(obs.state('s1')?.lastReply).toBe('All tests pass.');
    expect(attention).toEqual(['needs_input', 'done']);
  });

  it('merges tool start and finish into one activity entry with output and duration', () => {
    const { obs } = setup();
    obs.claudeHook('s1', ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } }));
    obs.claudeHook('s1', ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_response: { stdout: 'a\nb', stderr: '' }, duration_ms: 42 }));
    const tools = obs.list('s1').filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ tool: 'Bash', status: 'ok', durationMs: 42, summary: 'ls', output: 'a\nb' });
  });

  it('records failed tools, edits as diffs, and the files an agent touched', () => {
    const { obs } = setup();
    obs.claudeHook('s1', ev('PreToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' } }));
    obs.claudeHook('s1', ev('PostToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, tool_response: {} }));
    obs.claudeHook('s1', ev('PreToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: '/repo/missing.ts' } }));
    obs.claudeHook('s1', ev('PostToolUseFailure', { tool_name: 'Read', tool_use_id: 'r1', error: 'File does not exist.' }));
    const [edit, read] = obs.list('s1');
    expect(edit).toMatchObject({ summary: 'a.ts', output: '-x\n+y', status: 'ok' });
    expect(read).toMatchObject({ status: 'error', output: 'File does not exist.' });
    expect(obs.touched('s1')).toEqual(['/repo/a.ts']);
  });

  it('attributes subagent tool calls and ignores untyped internal helpers', () => {
    const { obs } = setup();
    obs.claudeHook('s1', ev('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }));
    obs.claudeHook('s1', ev('SubagentStart', { agent_id: 'a2', agent_type: '' }));
    expect(obs.state('s1')?.subagentsRunning).toBe(1);
    obs.claudeHook('s1', ev('PreToolUse', { tool_name: 'Grep', tool_use_id: 'g1', agent_id: 'a1', agent_type: 'Explore', tool_input: { pattern: 'TODO' } }));
    expect(obs.list('s1').find((e) => e.tool === 'Grep')).toMatchObject({ agentId: 'a1', agentType: 'Explore' });
    obs.claudeHook('s1', ev('SubagentStop', { agent_id: 'a1', agent_type: 'Explore' }));
    expect(obs.state('s1')?.subagentsRunning).toBe(0);
  });

  it('reads context, cost, title and plan limits from the status line JSON', () => {
    const { obs } = setup();
    obs.claudeStatus('s1', {
      model: { display_name: 'Opus 5.5' }, session_name: 'Fix login', cost: { total_cost_usd: 1.5, total_lines_added: 10, total_lines_removed: 2 },
      context_window: { used_percentage: 42, context_window_size: 200000, current_usage: { input_tokens: 10, cache_read_input_tokens: 83990, cache_creation_input_tokens: 0 } },
      rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } },
    });
    expect(obs.state('s1')).toMatchObject({ model: 'Opus 5.5', title: 'Fix login', costUsd: 1.5, context: { usedPct: 42, usedTokens: 84000, windowTokens: 200000 } });
    expect(obs.claudeLimits.fiveHour).toEqual({ usedPct: 23.5, resetsAt: 1738425600000 });
  });

  it('summarises common tools', () => {
    expect(toolSummary('Read', { file_path: '/repo/src/x.ts' }, '/repo')).toBe('src/x.ts');
    expect(toolSummary('mcp__claude_ai_Slack__slack_search', { query: 'deploy' }, null)).toBe('Slack · slack_search deploy');
    expect(toolSummary('Agent', { subagent_type: 'Explore', description: 'find auth' }, null)).toBe('Explore: find auth');
  });
});

describe('Codex rollout observer', () => {
  it('binds the rollout for a Jarvis session by cwd and replays it into state and activity', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const d = new Date();
    const dir = join(root, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-test.jsonl');
    const now = new Date().toISOString();
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    writeFileSync(file, line({ timestamp: now, type: 'session_meta', payload: { id: 'cx-1', cwd: '/proj', timestamp: now, cli_version: '0.150.0' } }));
    const { obs } = setup();
    const ids: string[] = [];
    obs.on('agentSessionId', (x: { agentSessionId: string }) => ids.push(x.agentSessionId));
    const cx = new CodexObserver(obs, root);
    cx.track('s9', '/proj', Date.now() - 1000);
    cx.tick();
    expect(ids).toEqual(['cx-1']);
    appendFileSync(file, [
      line({ timestamp: now, type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'high' } }),
      line({ timestamp: now, type: 'event_msg', payload: { type: 'task_started' } }),
      line({ timestamp: now, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' } }),
      line({ timestamp: now, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 25840 }, model_context_window: 258400 } } }),
      line({ timestamp: now, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'README.md' } }),
      line({ timestamp: now, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Listed files.' } }),
    ].join(''));
    cx.tick();
    expect(obs.state('s9')).toMatchObject({ phase: 'done', model: 'gpt-5.6-terra (high)', lastReply: 'Listed files.', context: { usedPct: 10, windowTokens: 258400 } });
    expect(obs.list('s9').find((e) => e.kind === 'tool')).toMatchObject({ tool: 'shell', status: 'ok', output: 'README.md' });
  });
});

describe('misc parsers', () => {
  it('reads every gh account', () => {
    const out = '  ✓ Logged in to github.com account work-account (keyring)\n  ✓ Logged in to github.com account personal-account (keyring)';
    expect(parseAccounts(out)).toEqual(['work-account', 'personal-account']);
  });
  it('picks the open PR for a branch, else the latest merged one', () => {
    const pr = (o: Partial<PullRequest>): PullRequest => ({
      account: 'a', repo: 'o/r', number: 1, title: '', url: '', isDraft: false, headRef: 'feat', baseRef: 'main', updatedAt: '',
      checks: null, review: null, mergeable: null, additions: 0, deletions: 0, comments: 0, role: 'author', state: 'OPEN', mergedAt: null, ...o,
    });
    const merged1 = pr({ number: 1, state: 'MERGED', mergedAt: '2026-10-01T00:00:00Z' });
    const merged2 = pr({ number: 2, state: 'MERGED', mergedAt: '2026-10-05T00:00:00Z' });
    expect(pickBranchPr([merged1, merged2], 'O/R', 'feat')?.number).toBe(2);
    expect(pickBranchPr([merged2, pr({ number: 3, role: 'reviewer' }), pr({ number: 4 })], 'o/r', 'feat')?.number).toBe(4);
    expect(pickBranchPr([merged2], 'o/r', 'other')).toBeNull();
  });
  it('rolls worktrees up to their repo', () => {
    expect(projectOf('/x/repo/.claude/worktrees/feat-1/src')).toBe('/x/repo');
  });
});

void DatabaseSync;
