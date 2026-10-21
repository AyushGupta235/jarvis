import { describe, expect, it } from 'vitest';
import { filterUserConf, parseSessionList } from '../src/tmux';
import { buildAgentCommand, shellQuote } from '../src/service';
import { BUILTIN_AGENTS, fill, mergeAgents } from '../src/agents';
import { cleanEnv } from '../src/env';

const claude = BUILTIN_AGENTS.find((a) => a.id === 'claude')!;

describe('filterUserConf', () => {
  const conf = [
    "set -g @plugin 'tmux-plugins/tpm'",
    "set -g @plugin 'tmux-plugins/tmux-continuum'",
    "set -g @continuum-restore 'on'",
    "set -g @resurrect-capture-pane-contents 'on'",
    'setw -g mode-keys vi',
    'bind r source-file ~/.tmux.conf \; display-message "reloaded"',
    "run '~/.tmux/plugins/tpm/tpm'",
  ].join('\n');
  const out = filterUserConf(conf, '/j/tmux.conf');

  it('drops plugin, continuum and resurrect lines so the Jarvis server never restores or overwrites snapshots', () => {
    expect(out).not.toMatch(/@plugin|@continuum|@resurrect|tpm/);
  });
  it('keeps ordinary settings', () => {
    expect(out).toContain('setw -g mode-keys vi');
  });
  it('points reload bindings at the Jarvis config', () => {
    expect(out).toContain('source-file /j/tmux.conf');
  });
});

describe('parseSessionList', () => {
  it('parses tmux list-sessions output', () => {
    const line = ['j-abc', 'abc', '1700000000', '1', '/repo', '2.1.304', '4242', '1699999000'].join(':::J:::');
    const [s] = parseSessionList(`${line}\n`);
    expect(s).toEqual({
      name: 'j-abc', jarvisId: 'abc', activity: 1_700_000_000_000, attached: 1, currentPath: '/repo',
      currentCommand: '2.1.304', panePid: 4242, created: 1_699_999_000_000,
    });
  });
  it('treats an empty @jarvis_id as unknown', () => {
    const [s] = parseSessionList(['x', '', '1', '0', '/', 'zsh', '1', '1'].join(':::J:::'));
    expect(s?.jarvisId).toBeNull();
  });
});

describe('buildAgentCommand', () => {
  const row = { model: 'opus', agent_session_id: '1111-2222', name: 'my repo' };
  it('pins the Claude session id, name and model on first start', () => {
    expect(buildAgentCommand(claude, row, { resume: false })).toBe("claude --session-id 1111-2222 -n 'my repo' --model opus");
  });
  it('resumes by session id on revive', () => {
    expect(buildAgentCommand(claude, row, { resume: true })).toBe('claude --resume 1111-2222 --model opus');
  });
  it('drops arg groups whose placeholder is unset', () => {
    expect(buildAgentCommand(claude, { model: null, agent_session_id: null, name: '' }, { resume: false })).toBe('claude');
  });
  it('returns null for the plain shell', () => {
    expect(buildAgentCommand(BUILTIN_AGENTS.find((a) => a.id === 'shell')!, row, { resume: false })).toBeNull();
  });
  it('builds a user-defined local-model agent', () => {
    const pi = { id: 'pi-local', label: 'Pi', command: 'pi', args: ['--provider', 'ollama'], modelArgs: ['--model', '{model}'] };
    expect(buildAgentCommand(pi, { ...row, model: 'qwen3-coder:30b' }, { resume: false })).toBe('pi --provider ollama --model qwen3-coder:30b');
  });
});

describe('agents', () => {
  it('lets agents.json override a built-in by id and add new ones', () => {
    const merged = mergeAgents(BUILTIN_AGENTS, [
      { id: 'codex', label: 'Codex (fast)', command: 'codex', args: ['--profile', 'fast'] },
      { id: 'local', label: 'Local', command: 'pi' },
    ]);
    expect(merged.find((a) => a.id === 'codex')).toMatchObject({ label: 'Codex (fast)', args: ['--profile', 'fast'], glyph: '◎', source: 'user' });
    expect(merged.find((a) => a.id === 'local')?.source).toBe('user');
    expect(merged.find((a) => a.id === 'claude')?.source).toBe('builtin');
  });
  it('fills placeholders', () => {
    expect(fill(['--model', '{model}'], { model: 'x' })).toEqual(['--model', 'x']);
    expect(fill(['--model', '{model}'], { model: null })).toEqual([]);
  });
});

describe('shellQuote', () => {
  it('leaves safe words alone and quotes the rest', () => {
    expect(shellQuote('--model')).toBe('--model');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('a b')).toBe(`'a b'`);
  });
});

describe('cleanEnv', () => {
  it('strips variables that would make agents think they are nested', () => {
    const env = cleanEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', TMUX: '/tmp/x', TMUX_PANE: '%1', PATH: '/usr/bin', JARVIS_HOME: '/h', HOME: '/u' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
    expect(env.JARVIS_HOME).toBe('/h');
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
  });
});
