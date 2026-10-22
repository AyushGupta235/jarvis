import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPlaceholderName } from '../src/db';
import { createWorktree, slugify } from '../src/git';
import { buildAgentCommand } from '../src/service';
import { BUILTIN_AGENTS } from '../src/agents';
import { TitleTracker } from '../src/titles';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TitleTracker', () => {
  it('follows the title Claude gives the conversation, reading only what was appended', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jarvis-titles-'));
    mkdirSync(join(home, 'projects/-x'), { recursive: true });
    const f = join(home, 'projects/-x/abc.jsonl');
    writeFileSync(f, '{"type":"user","message":{"content":"hi"}}\n{"type":"ai-title","aiTitle":"Pod startup failing","sessionId":"abc"}\n');
    const t = new TitleTracker(home, 0);
    t.get('abc');
    await sleep(60);
    expect(t.get('abc')).toBe('Pod startup failing');

    appendFileSync(f, '{"type":"ai-title","aiTitle":"Fix the pod probe","sessionId":"abc"}\n');
    t.get('abc');
    await sleep(60);
    expect(t.get('abc')).toBe('Fix the pod probe');

    // A name from /rename beats the generated one; Jarvis's own placeholder does not.
    appendFileSync(f, '{"type":"custom-title","customTitle":"atlas","sessionId":"abc"}\n');
    t.get('abc');
    await sleep(60);
    expect(t.get('abc', (x) => isPlaceholderName(x, 'atlas'))).toBe('Fix the pod probe');
    appendFileSync(f, '{"type":"custom-title","customTitle":"Probe migration","sessionId":"abc"}\n');
    t.get('abc');
    await sleep(60);
    expect(t.get('abc', (x) => isPlaceholderName(x, 'atlas'))).toBe('Probe migration');

    // A half-written last line is read once it is complete.
    appendFileSync(f, '{"type":"custom-title","customTi');
    t.get('abc');
    await sleep(60);
    expect(t.get('abc')).toBe('Probe migration');
    appendFileSync(f, 'tle":"Done now","sessionId":"abc"}\n');
    t.get('abc');
    await sleep(60);
    expect(t.get('abc')).toBe('Done now');
    expect(t.get('missing')).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});

describe('placeholder names and Claude launch', () => {
  it('recognises the names Jarvis gives on its own', () => {
    for (const n of ['atlas', 'atlas 2', 'atlas shell', 'atlas shell 3']) expect(isPlaceholderName(n, 'atlas')).toBe(true);
    for (const n of ['atlas pod fix', 'my atlas', 'atlas 2x']) expect(isPlaceholderName(n, 'atlas')).toBe(false);
    expect(isPlaceholderName('a.b', 'a.b')).toBe(true);
    expect(isPlaceholderName('axb', 'a.b')).toBe(false);
  });
  it('only pins -n for a name you chose', () => {
    const claude = BUILTIN_AGENTS.find((a) => a.id === 'claude')!;
    const row = { model: null, agent_session_id: '1111', name: 'atlas' };
    expect(buildAgentCommand(claude, { ...row, name_locked: 0 }, { resume: false })).toBe('claude --session-id 1111');
    expect(buildAgentCommand(claude, { ...row, name_locked: 1 }, { resume: false })).toBe("claude --session-id 1111 -n atlas");
  });
});

describe('createWorktree', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

  it('cuts a new branch and folder from the checkout, outside the repo unless .worktrees is ignored', async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-wt-')));
    const repo = join(tmp, 'atlas');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');

    const a = await createWorktree(repo, repo, 'jarvis/one', join(tmp, 'home'));
    expect(a.path).toBe(join(tmp, 'home/worktrees/atlas/one'));
    expect(git(a.path, 'branch', '--show-current')).toBe('jarvis/one');

    // The same branch name again gets a free one instead of failing.
    const b = await createWorktree(repo, repo, 'jarvis/one', join(tmp, 'home'));
    expect(b.branch).toBe('jarvis/one-2');
    expect(b.path).toBe(join(tmp, 'home/worktrees/atlas/one-2'));

    // A repo that keeps worktrees in an ignored .worktrees/ gets them there.
    mkdirSync(join(repo, '.worktrees'));
    writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
    const c = await createWorktree(repo, repo, 'jarvis/two', join(tmp, 'home'));
    expect(c.path).toBe(join(repo, '.worktrees/two'));
    expect(git(repo, 'status', '--porcelain')).toBe('?? .gitignore');

    await expect(createWorktree(join(tmp, 'nope'), repo, 'x/y', join(tmp, 'home'))).rejects.toThrow(/worktree/);
    expect(slugify('Fix the login bug!')).toBe('fix-the-login-bug');
    rmSync(tmp, { recursive: true, force: true });
  });
});
