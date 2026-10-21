import { execFile } from 'node:child_process';
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

let loginEnvCache: Promise<NodeJS.ProcessEnv> | null = null;

/**
 * Your interactive login shell's environment (PATH from .zshrc, nvm, pyenv...), cleaned like cleanEnv.
 * Terminal sessions get this for free by starting agents through `zsh -l -i -c`; rich session hosts
 * are spawned directly, so they ask once and reuse it. Falls back to the daemon's own env.
 */
export function loginEnv(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  loginEnvCache ??= new Promise((resolve) => {
    const marker = '__JARVIS_ENV__';
    execFile(userShell(), ['-l', '-i', '-c', `printf '\\0${marker}\\0'; env -0`], { env: base, timeout: 15_000, maxBuffer: 4 << 20 },
      (err, stdout) => {
        const out = String(stdout ?? '');
        const at = out.indexOf(`\0${marker}\0`);
        if (at < 0) {
          resolve(cleanEnv(base));
          return;
        }
        const env: NodeJS.ProcessEnv = {};
        for (const kv of out.slice(at + marker.length + 2).split('\0')) {
          const i = kv.indexOf('=');
          if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
        }
        for (const [k, v] of Object.entries(base)) if (k.startsWith('JARVIS_') && v !== undefined) env[k] = v;
        resolve(cleanEnv(env));
        void err;
      });
  });
  return loginEnvCache;
}
