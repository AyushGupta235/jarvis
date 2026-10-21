import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Connector } from '@jarvis/protocol';

interface McpConf { type?: string; command?: string; url?: string; args?: string[] }

/** What to show for a server: the executable or the URL host. Never env vars, headers or tokens. */
function describe(c: McpConf): { transport: string | null; detail: string | null } {
  if (c.url) {
    try {
      return { transport: c.type ?? 'http', detail: new URL(c.url).host };
    } catch {
      return { transport: c.type ?? 'http', detail: null };
    }
  }
  if (c.command) return { transport: c.type ?? 'stdio', detail: c.command.split('/').pop() ?? c.command };
  return { transport: c.type ?? null, detail: null };
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function enabledPlugins(): string[] {
  const s = readJson(join(homedir(), '.claude', 'settings.json'));
  return Object.entries((s?.enabledPlugins ?? {}) as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k.split('@')[0] ?? k);
}

function pluginServers(): { plugin: string; name: string; conf: McpConf }[] {
  const root = join(homedir(), '.claude', 'plugins', 'cache');
  const want = new Set(enabledPlugins());
  const out: { plugin: string; name: string; conf: McpConf }[] = [];
  if (!existsSync(root)) return out;
  for (const market of readdirSync(root)) {
    for (const plugin of safeDir(join(root, market))) {
      if (!want.has(plugin)) continue;
      const versions = safeDir(join(root, market, plugin)).sort().reverse();
      const dir = versions[0] ? join(root, market, plugin, versions[0]) : null;
      if (!dir) continue;
      const mcp = readJson(join(dir, '.mcp.json'));
      const servers = (mcp?.mcpServers ?? mcp ?? {}) as Record<string, McpConf>;
      for (const [name, conf] of Object.entries(servers)) if (conf && typeof conf === 'object') out.push({ plugin, name, conf });
    }
  }
  return out;
}

function safeDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function codexServers(path: string): string[] {
  try {
    const names = new Set<string>();
    for (const m of readFileSync(path, 'utf8').matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm)) if (m[1]) names.add(m[1]);
    return [...names];
  } catch {
    return [];
  }
}

/** MCP servers ("connectors") available to the session's agent, with how often they were actually called. */
/** A friendly name for a connector known only by id, from one of its tool names (e.g. slack_send_message -> Slack). */
export function nameFromTool(tool: string | null): string | null {
  if (!tool) return null;
  const head = tool.split(/[_-]/)[0];
  if (!head || head.length < 3) return null;
  const known: Record<string, string> = { gh: 'GitHub', gmail: 'Gmail', gdrive: 'Google Drive', jira: 'Jira' };
  return known[head] ?? head.charAt(0).toUpperCase() + head.slice(1);
}

export function listConnectors(
  agent: string, cwd: string, repoRoot: string, recent: Map<string, { calls: number; lastUsed: number; sample?: string | null }>,
): Connector[] {
  const out: Connector[] = [];
  const seen = new Set<string>();
  const usage = (name: string) =>
    recent.get(name) ?? recent.get(name.replace(/[^A-Za-z0-9_-]/g, '_')) ?? recent.get(`claude_ai_${name.replace(/ /g, '_')}`);
  const push = (c: Omit<Connector, 'recentCalls' | 'lastUsed'>) => {
    const k = `${c.agent}:${c.name}`;
    if (seen.has(k)) return;
    seen.add(k);
    const u = usage(c.name);
    out.push({ ...c, recentCalls: u?.calls ?? 0, lastUsed: u?.lastUsed ?? null });
  };
  if (agent !== 'codex') {
    const cfg = readJson(join(homedir(), '.claude.json')) ?? {};
    for (const [name, conf] of Object.entries((cfg.mcpServers ?? {}) as Record<string, McpConf>)) push({ agent: 'claude', name, scope: 'user', ...describe(conf) });
    for (const key of [cwd, repoRoot]) {
      for (const [name, conf] of Object.entries((cfg.projects?.[key]?.mcpServers ?? {}) as Record<string, McpConf>)) push({ agent: 'claude', name, scope: 'project', ...describe(conf) });
    }
    const repoMcp = readJson(join(repoRoot, '.mcp.json'));
    for (const [name, conf] of Object.entries((repoMcp?.mcpServers ?? {}) as Record<string, McpConf>)) push({ agent: 'claude', name, scope: 'repo', ...describe(conf) });
    for (const p of pluginServers()) push({ agent: 'claude', name: `plugin_${p.plugin}_${p.name}`, scope: 'plugin', ...describe(p.conf), detail: `${p.plugin} plugin` });
    // claude.ai connectors aren't in local config; they show up as mcp__<server>__ tool calls in transcripts.
    for (const [name, u] of recent) {
      if ([...seen].some((k) => k.endsWith(`:${name}`))) continue;
      if (name.startsWith('claude_ai_')) {
        push({ agent: 'claude', name: name.slice(10).replace(/_/g, ' '), scope: 'claude.ai', transport: 'remote', detail: name });
      } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name)) {
        const label = nameFromTool(u.sample ?? null);
        push({ agent: 'claude', name: label ?? `connector ${name.slice(0, 8)}`, scope: 'claude.ai', transport: 'remote',
          detail: u.sample ? `e.g. ${u.sample}` : name });
      }
    }
  }
  if (agent === 'codex' || agent === 'claude') {
    for (const name of codexServers(join(homedir(), '.codex', 'config.toml'))) push({ agent: 'codex', name, scope: 'user', transport: null, detail: '~/.codex/config.toml' });
    for (const name of codexServers(join(repoRoot, '.codex', 'config.toml'))) push({ agent: 'codex', name, scope: 'repo', transport: null, detail: '.codex/config.toml' });
  }
  return out.sort((a, b) => b.recentCalls - a.recentCalls || a.name.localeCompare(b.name));
}

/** Live health check: runs the agent's own `mcp list` in the session directory. */
export function checkConnectors(agent: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const cmd = agent === 'codex' ? ['codex', ['mcp', 'list']] as const : ['claude', ['mcp', 'list']] as const;
  return new Promise((res) => {
    execFile(cmd[0], [...cmd[1]], { cwd, env, timeout: 90_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      res((stdout || '') + (stderr ? `\n${stderr}` : '') + (err && !stdout ? `\n${err.message}` : ''));
    });
  });
}
