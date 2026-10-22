import { describe, expect, it } from 'vitest';
import { cleanShellOutput, shellContext } from '../src/renderer/src/shellText';

describe('cleanShellOutput', () => {
  it('drops colour codes and lets a carriage return overwrite its line', () => {
    expect(cleanShellOutput('\u001b[32mok\u001b[0m done')).toBe('ok done');
    expect(cleanShellOutput('10%\r50%\r100%\nfinished')).toBe('100%\nfinished');
  });
});

describe('shellContext', () => {
  it('says what was run, how it ended and what it printed', () => {
    const t = shellContext([
      { id: 'a', command: 'ls docs', output: 'guide.md\n', state: 'done', exitCode: 0 },
      { id: 'b', command: 'make test', output: 'boom\n', state: 'done', exitCode: 2 },
      { id: 'c', command: 'sleep 99', output: '', state: 'stopped', exitCode: null },
    ]);
    expect(t).toContain('I ran this in my shell (exit code 0):\n$ ls docs\nguide.md');
    expect(t).toContain('(exit code 2):\n$ make test\nboom');
    expect(t).toContain('(I stopped it):\n$ sleep 99\n(no output)');
  });
  it('keeps only the tail of a very long output', () => {
    const t = shellContext([{ id: 'a', command: 'yes', output: `${'x'.repeat(20_000)}END\n`, state: 'done', exitCode: 0 }]);
    expect(t).toContain('(earlier output cut)');
    expect(t.endsWith('END')).toBe(true);
    expect(t.length).toBeLessThan(13_000);
  });
});
