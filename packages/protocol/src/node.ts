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
