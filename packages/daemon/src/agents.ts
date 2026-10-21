import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDef } from '@jarvis/protocol';
import { userShell } from './env';
import { logError } from './log';

/**
 * Built-in agent launch recipes. Every agent runs as its own CLI in a tmux pane; Jarvis never wraps or
 * replaces its UI. Override or add agents in ~/.jarvis/agents.json (same shape, matched by id).
 */
export const BUILTIN_AGENTS: AgentDef[] = [
  {
    id: 'claude', label: 'Claude Code', command: 'claude', glyph: '✳', integration: 'claude',
    modelArgs: ['--model', '{model}'],
    models: [
      { value: null, label: 'Default' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'claude-fable-5-1', label: 'Fable 5.1' },
    ],
    sessionIdArgs: ['--session-id', '{sessionId}'],
    resumeArgs: ['--resume', '{sessionId}'],
    nameArgs: ['-n', '{name}'],
  },
  { id: 'codex', label: 'Codex', command: 'codex', glyph: '◎', integration: 'codex', modelArgs: ['--model', '{model}'] },
  // Pi: --model accepts provider/id (e.g. ollama/qwen3-coder), so local models work without extra config.
  { id: 'pi', label: 'Pi', command: 'pi', glyph: 'π', modelArgs: ['--model', '{model}'] },
  // Hermes Agent (Nous Research): model is chosen with `hermes model` or /model inside the session.
  { id: 'hermes', label: 'Hermes', command: 'hermes', glyph: 'ħ' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', glyph: '◇', modelArgs: ['--model', '{model}'] },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', glyph: '✦', modelArgs: ['--model', '{model}'] },
  { id: 'aider', label: 'Aider', command: 'aider', glyph: 'a', modelArgs: ['--model', '{model}'] },
  { id: 'shell', label: 'Shell', command: '', glyph: '›' },
];

export function loadUserAgents(home: string): AgentDef[] {
  const file = join(home, 'agents.json');
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const list = Array.isArray(raw) ? raw : [];
    return list
      .filter((a): a is AgentDef => !!a && typeof a === 'object' && typeof (a as AgentDef).id === 'string')
      .map((a) => ({ ...a, label: a.label || a.id, command: a.command ?? a.id, source: 'user' as const }));
  } catch (e) {
    logError(`ignoring ${file}:`, (e as Error).message);
    return [];
  }
}

export function mergeAgents(builtin: AgentDef[], user: AgentDef[]): AgentDef[] {
  const out = new Map<string, AgentDef>();
  for (const a of builtin) out.set(a.id, { ...a, source: 'builtin' });
  for (const a of user) out.set(a.id, { ...(out.get(a.id) ?? {}), ...a, source: 'user' });
  return [...out.values()];
}

/** Resolve each agent's command through an interactive login shell, so PATH matches what panes see. */
export function detectCommands(commands: string[], env: NodeJS.ProcessEnv): Promise<Map<string, string | null>> {
  const uniq = [...new Set(commands.filter(Boolean))];
  const script = uniq.map((c) => `printf 'JARVIS\\t%s\\t%s\\n' ${q(c)} "$(command -v ${q(c)} 2>/dev/null)"`).join('; ');
  return new Promise((resolve) => {
    execFile(userShell(), ['-l', '-i', '-c', script], { env, timeout: 15_000 }, (err, stdout) => {
      const found = new Map<string, string | null>(uniq.map((c) => [c, null]));
      if (err && !stdout) logError('agent detection failed:', err.message);
      for (const line of String(stdout).split('\n')) {
        const [tag, cmd, path] = line.split('\t');
        if (tag === 'JARVIS' && cmd) found.set(cmd, path?.trim() || null);
      }
      resolve(found);
    });
  });
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function fill(args: string[] | undefined, vars: Record<string, string | null | undefined>): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const a of args) {
    let missing = false;
    const v = a.replace(/\{(\w+)\}/g, (_, k: string) => {
      const x = vars[k];
      if (x == null || x === '') missing = true;
      return x ?? '';
    });
    if (missing) return []; // a group with an unset placeholder is dropped entirely
    out.push(v);
  }
  return out;
}

export class AgentRegistry {
  private agents: AgentDef[] = [];
  private detectedAt = 0;
  private pending: Promise<void> | null = null;

  constructor(private readonly home: string, private readonly env: NodeJS.ProcessEnv) {
    this.agents = mergeAgents(BUILTIN_AGENTS, loadUserAgents(home));
  }

  list(): AgentDef[] {
    return this.agents;
  }

  get(id: string): AgentDef {
    const a = this.agents.find((x) => x.id === id);
    if (!a) throw new Error(`unknown agent "${id}" (known: ${this.agents.map((x) => x.id).join(', ')})`);
    return a;
  }

  async refresh(force = false): Promise<AgentDef[]> {
    if (!force && Date.now() - this.detectedAt < 60_000) return this.agents;
    if (!this.pending) {
      this.pending = (async () => {
        const merged = mergeAgents(BUILTIN_AGENTS, loadUserAgents(this.home));
        const paths = await detectCommands(merged.map((a) => a.command), this.env);
        this.agents = merged.map((a) => {
          const path = a.command ? paths.get(a.command) ?? null : null;
          return { ...a, path, available: !a.command || !!path };
        });
        this.detectedAt = Date.now();
      })().finally(() => {
        this.pending = null;
      });
    }
    await this.pending;
    return this.agents;
  }
}
