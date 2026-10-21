import { describe, expect, it } from 'vitest';
import { shortenCommand, shortenPaths } from '../src/renderer/src/toolText';

const cwd = '/Users/me/code/api-server';
const home = '/Users/me';

describe('shortenCommand (rich view tool rows)', () => {
  it('drops cd prefixes and makes repo paths relative', () => {
    expect(shortenCommand('cd /Users/me/code/api-server/.worktrees/feature-x && git fetch -q origin', cwd, home)).toBe('git fetch -q origin');
    expect(shortenCommand('cd ~/code/web && grep -rn x .', cwd, home)).toBe('grep -rn x .');
    expect(shortenCommand("cd '/a b' ; cd /c && ls", cwd, home)).toBe('ls');
    expect(shortenCommand('sed -n 1,80p /Users/me/code/api-server/handler/mirror.go', cwd, home)).toBe('sed -n 1,80p handler/mirror.go');
  });
  it('shortens home, scratchpads and temp dirs', () => {
    expect(shortenPaths('ls /Users/me/code/other', cwd, home)).toBe('ls ~/code/other');
    expect(shortenPaths('cat /private/tmp/claude-501/-Users-me-code-api-server/171e1e91-e610-4603-ad72-3062d31624d0/scratchpad/prod/x.log', cwd, home)).toBe('cat …/scratchpad/prod/x.log');
    expect(shortenPaths('ls /var/folders/6d/b28fb/T/jarvis-x', cwd, home)).toBe('ls $TMPDIR/jarvis-x');
  });
  it('makes paths relative to a session folder under the temp dir, with or without /private', () => {
    const tcwd = '/var/folders/6d/b28/T/jarvis-x/repos/atlas';
    expect(shortenPaths('/var/folders/6d/b28/T/jarvis-x/repos/atlas/README.md', tcwd, home)).toBe('README.md');
    expect(shortenPaths('cat /private/var/folders/6d/b28/T/jarvis-x/repos/atlas/src/a.ts', tcwd, home)).toBe('cat src/a.ts');
  });
  it('leaves a cd that is the whole command, and the repo root itself, readable', () => {
    expect(shortenCommand('cd /tmp', cwd, home)).toBe('cd /tmp');
    expect(shortenPaths('git -C /Users/me/code/api-server status', cwd, home)).toBe('git -C . status');
  });
});
