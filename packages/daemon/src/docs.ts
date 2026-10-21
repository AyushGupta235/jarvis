import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import type { DocEntry } from '@jarvis/protocol';

const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md', '.cursorrules'];

function mdIn(dir: string, limit = 60, depth = 2): string[] {
  const out: string[] = [];
  const walk = (d: string, lvl: number) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory() && lvl < depth) walk(p, lvl + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
      if (out.length >= limit) return;
    }
  };
  walk(dir, 0);
  return out;
}

/** Markdown an agent reads or writes for this session: instructions, repo docs, agent config, plans, touched files. */
export function listDocs(cwd: string, repoRoot: string, touched: string[]): DocEntry[] {
  const home = homedir();
  const out: DocEntry[] = [];
  const seen = new Set<string>();
  const add = (path: string, group: DocEntry['group'], label?: string) => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    out.push({ path, group, label: label ?? (path.startsWith(repoRoot + '/') ? relative(repoRoot, path) : path.replace(home, '~')) });
  };

  // Instruction chain: global, then from repo root down to cwd.
  for (const f of ['.claude/CLAUDE.md', 'AGENTS.md', '.codex/AGENTS.md']) add(join(home, f), 'Agent instructions');
  const chain: string[] = [];
  for (let d = cwd; d.startsWith(repoRoot) && d !== dirname(d); d = dirname(d)) chain.unshift(d);
  if (!chain.includes(repoRoot)) chain.unshift(repoRoot);
  for (const d of chain) for (const f of INSTRUCTION_FILES) add(join(d, f), 'Agent instructions');
  add(join(repoRoot, '.claude', 'CLAUDE.md'), 'Agent instructions');

  for (const f of ['README.md', 'PLAN.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md', 'CHANGELOG.md']) add(join(repoRoot, f), 'Repo docs');
  for (const p of mdIn(repoRoot, 40, 0)) add(p, 'Repo docs');
  for (const d of ['docs', 'doc', '.planning']) for (const p of mdIn(join(repoRoot, d), 60, 2)) add(p, 'Repo docs');

  for (const d of ['.claude/agents', '.claude/commands', '.codex/prompts']) for (const p of mdIn(join(repoRoot, d), 40, 1)) add(p, 'Agents, commands & skills');
  const skills = join(repoRoot, '.claude', 'skills');
  if (existsSync(skills)) for (const s of readdirSync(skills)) add(join(skills, s, 'SKILL.md'), 'Agents, commands & skills', `skill: ${s}`);

  const plans = join(home, '.claude', 'plans');
  if (existsSync(plans)) {
    const files = readdirSync(plans).filter((f) => f.endsWith('.md')).map((f) => join(plans, f));
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const p of files.slice(0, 15)) add(p, 'Plans', basename(p));
  }

  for (const p of touched) if (p.toLowerCase().endsWith('.md')) add(p, 'Touched this session');
  return out;
}
