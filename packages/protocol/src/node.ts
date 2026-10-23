/** Node-only helpers (filesystem paths). Not importable from the renderer. */
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/** Root of all Jarvis state. Override with JARVIS_HOME (tests use a temp dir). */
export function jarvisHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.JARVIS_HOME || join(homedir(), '.jarvis');
}

/** tmux socket name (`tmux -L <name>`). Override with JARVIS_TMUX_SOCKET. */
export function tmuxSocketName(env: NodeJS.ProcessEnv = process.env): string {
  return env.JARVIS_TMUX_SOCKET || 'jarvis';
}

/** macOS caps unix socket paths at 104 bytes; long JARVIS_HOME paths get a short hashed socket in /tmp. */
const MAX_SOCKET_PATH = 100;

export function daemonSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JARVIS_SOCKET) return env.JARVIS_SOCKET;
  const home = jarvisHome(env);
  const p = join(home, 'jarvisd.sock');
  if (Buffer.byteLength(p) <= MAX_SOCKET_PATH) return p;
  const h = createHash('sha1').update(home).digest('hex').slice(0, 10);
  return join('/tmp', `jarvisd-${userInfo().uid}-${h}.sock`);
}

/** Where a rich session's host listens. Same 104-byte rule as the daemon socket. */
export function richSocketPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = jarvisHome(env);
  const p = join(home, 'rich', `${id}.sock`);
  if (Buffer.byteLength(p) <= MAX_SOCKET_PATH) return p;
  const h = createHash('sha1').update(home).digest('hex').slice(0, 10);
  return join('/tmp', `jarvis-rich-${userInfo().uid}-${h}-${id}.sock`);
}

/** Everything a rich session host needs, passed in JARVIS_HOST_CONFIG. */
export interface RichHostConfig {
  id: string;
  socketPath: string;
  /** JSON file the host writes with its pid while it runs, so jarvisd can find it again after a restart. */
  metaPath: string;
  cwd: string;
  agentSessionId: string;
  resume: boolean;
  model: string | null;
  permissionMode: string | null;
  claudePath: string | null;
  /** Jarvis's hook settings file, so the cockpit's observers see rich sessions like terminal ones. */
  settingsPath: string | null;
  /** The conversation's running cost when the last host stopped, so the first turn after a restart can be priced. */
  priorCostUsd?: number | null;
}

export interface RichHostMeta {
  pid: number;
  socketPath: string;
  agentSessionId: string;
  startedAt: number;
}
