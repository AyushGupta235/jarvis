import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveRefs, writeText } from '../src/files';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-files-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const repo = join(tmp, 'repo');
const web = join(repo, 'apps', 'web');
mkdirSync(web, { recursive: true });
mkdirSync(join(tmp, 'home'), { recursive: true });
writeFileSync(join(repo, '.env'), 'A=1\n');
writeFileSync(join(web, 'config.yaml'), 'x: 1\n');
writeFileSync(join(tmp, 'home', '.zshrc'), 'export A=1\n');

describe('resolveRefs', () => {
  const home = join(tmp, 'home');
  it('takes absolute and ~ paths as they are, if the file exists', () => {
    expect(resolveRefs([join(repo, '.env'), '~/.zshrc', '/nope/.env'], [], home)).toEqual([join(repo, '.env'), join(home, '.zshrc'), null]);
  });
  it('finds a relative path under the first base that has it, so a dotfile or a repo-relative path resolves from a subfolder', () => {
    const bases = [web, join(repo, 'apps'), repo];
    expect(resolveRefs(['.env', 'apps/web/config.yaml', 'config.yaml', 'missing.txt'], bases, home))
      .toEqual([join(repo, '.env'), join(web, 'config.yaml'), join(web, 'config.yaml'), null]);
  });
  it('does not return folders', () => {
    expect(resolveRefs(['apps'], [repo], home)).toEqual([null]);
  });
});

describe('writeText', () => {
  it('saves in place and keeps the file mode', () => {
    const f = join(tmp, 'secret.env');
    writeFileSync(f, 'A=1\n', { mode: 0o600 });
    const r = writeText(f, 'A=1\nB=2\n', statSync(f).mtimeMs);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('A=1\nB=2\n');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
  it('refuses to overwrite a file that changed since it was opened, unless told to', () => {
    const f = join(tmp, 'changed.env');
    writeFileSync(f, 'A=1\n');
    const opened = statSync(f).mtimeMs;
    writeFileSync(f, 'OTHER=1\n');
    utimesSync(f, new Date(), new Date(opened + 5000));
    const r = writeText(f, 'MINE=1\n', opened);
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect(readFileSync(f, 'utf8')).toBe('OTHER=1\n');
    expect(writeText(f, 'MINE=1\n', null).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('MINE=1\n');
  });
  it('creates a missing file (and its folders) only when asked', () => {
    const f = join(tmp, 'new', 'deep', '.env');
    expect(writeText(f, 'A=1\n', null)).toMatchObject({ ok: false });
    expect(writeText(f, 'A=1\n', null, true).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('A=1\n');
  });
  it('rejects relative paths', () => {
    expect(writeText('rel/.env', 'x', null, true)).toMatchObject({ ok: false });
  });
});
