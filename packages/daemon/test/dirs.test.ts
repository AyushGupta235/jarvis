import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { completeDirs, scanDirs } from '../src/dirs';

const repo = (p: string) => { mkdirSync(p, { recursive: true }); execFileSync('git', ['init', '-q', p]); };

describe('scanDirs', () => {
  it('lists every folder, git or not, and finds repos inside folders of repos', () => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-dirs-'));
    repo(join(root, 'alpha'));
    mkdirSync(join(root, 'fresh'));                // a folder you just made
    repo(join(root, 'team', 'api'));               // ~/code/team/api
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'file.txt'), 'x');
    const deep = scanDirs(root, true).map((d) => `${d.path.slice(root.length + 1)}:${d.git ? 'git' : 'dir'}`).sort();
    expect(deep).toEqual(['alpha:git', 'fresh:dir', 'team/api:git', 'team:dir']);
    // Home is scanned without looking inside folders.
    expect(scanDirs(root, false).map((d) => d.path.slice(root.length + 1)).sort()).toEqual(['alpha', 'fresh', 'team']);
    expect(scanDirs(join(root, 'nope'), true)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('completeDirs', () => {
  it('completes the path being typed and says whether it exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-dirs-'));
    for (const n of ['Documents', 'Downloads', 'code', '.config']) mkdirSync(join(root, n));
    writeFileSync(join(root, 'Dock.txt'), 'x');
    const names = (p: string) => completeDirs(p).entries.map((e) => e.path.slice(root.length + 1));
    expect(names(`${root}/Do`)).toEqual(['Documents', 'Downloads']);   // folders only, files are not offered
    expect(names(`${root}/`)).toEqual(['code', 'Documents', 'Downloads']);   // hidden ones only when you type the dot
    expect(names(`${root}/.c`)).toEqual(['.config']);
    expect(completeDirs(`${root}/code`).exists).toBe(true);
    const missing = completeDirs(`${root}/code/newproj`);
    expect(missing.exists).toBe(false);
    expect(missing.dir).toBe(`${root}/code/newproj`);
    rmSync(root, { recursive: true, force: true });
  });
});
