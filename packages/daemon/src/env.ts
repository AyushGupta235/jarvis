import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir, userInfo } from 'node:os';

/**
 * Variables that must never leak into the tmux server. The daemon may be started from inside a
 * Claude Code session, a tmux pane or Electron during development; if CLAUDECODE or TMUX reached
 * the panes, `claude` would think it is nested and `tmux attach` would refuse to run.
 */
const SCRUB = [
  /^CLAUDE/, /^CLAUDECODE$/, /^ANTHROPIC_/, /^MCP_/, /^CCD_/, /^TMUX/, /^ELECTRON_/, /^npm_/,
  /^VSCODE_/, /^TERM_PROGRAM/, /^ITERM/, /^WEZTERM/, /^NODE_OPTIONS$/, /^NODE_CHANNEL_FD$/,
  /^__CF/, /^XPC_/, /^OLDPWD$/, /^JARVIS_SESSION$/,
];

const EXTRA_PATH = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
  join(homedir(), '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin',
];

export function cleanEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (k.startsWith('JARVIS_') && k !== 'JARVIS_SESSION') { env[k] = v; continue; }
    if (SCRUB.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  const path = (env.PATH || '').split(delimiter).filter(Boolean);
  for (const p of EXTRA_PATH) if (!path.includes(p)) path.push(p);
  env.PATH = path.join(delimiter);
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_CTYPE = env.LC_CTYPE || 'en_US.UTF-8';
  env.SHELL = env.SHELL || userShell();
  env.HOME = env.HOME || homedir();
  env.USER = env.USER || userInfo().username;
  return env;
}

export function userShell(): string {
  try {
    const s = userInfo().shell;
    if (s) return s;
  } catch { /* ignore */ }
  return process.env.SHELL || '/bin/zsh';
}

export function findBinary(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
