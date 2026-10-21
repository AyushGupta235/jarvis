import { execFile } from 'node:child_process';
import type { DevServer } from '@jarvis/protocol';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 8 << 20 }, (_err, stdout) => resolve(String(stdout ?? '')));
  });
}

/** Processes that listen on localhost but are never a page you'd preview. */
const NOT_WEB = /^(ControlCe|rapportd|sharingd|AirPlay|Google Drive|Dropbox|Okta|Code Helper|Cursor Helper|Electron|Slack|Spotify|figma_agent|zoom|Raycast|Docker|com\.docker|postgres|redis-server|mongod|mysqld|tmux|sshd|ollama)/i;

/**
 * Local TCP servers, for the web preview's "open" list. Servers whose process runs in `root` (the session's
 * repo) come first, since that's the dev server you most likely want next to the agent.
 */
export async function listDevServers(root: string | null): Promise<DevServer[]> {
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  const byPort = new Map<number, { pid: number; command: string }>();
  let pid = 0;
  let command = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n')) {
      const m = /^(\*|127\.0\.0\.1|\[::1\]|\[::\]|0\.0\.0\.0|localhost):(\d+)$/.exec(line.slice(1));
      const port = m ? Number(m[2]) : 0;
      if (port >= 1024 && !byPort.has(port) && !NOT_WEB.test(command)) byPort.set(port, { pid, command });
    }
  }
  const pids = [...new Set([...byPort.values()].map((x) => x.pid))];
  const cwds = new Map<number, string>();
  if (pids.length) {
    const c = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']);
    let p = 0;
    for (const line of c.split('\n')) {
      if (line.startsWith('p')) p = Number(line.slice(1));
      else if (line.startsWith('n')) cwds.set(p, line.slice(1));
    }
  }
  const list: DevServer[] = [...byPort.entries()].map(([port, x]) => {
    const cwd = cwds.get(x.pid) ?? null;
    return {
      port, url: `http://localhost:${port}`, command: x.command, pid: x.pid, cwd,
      inSession: !!root && !!cwd && (cwd === root || cwd.startsWith(`${root}/`)),
    };
  });
  const webby = (c: string) => /^(node|bun|deno|python\d?(\.\d+)?|ruby|php|java|vite|next|nuxt|astro|remix|webpack)/i.test(c);
  list.sort((a, b) => Number(b.inSession) - Number(a.inSession) || Number(webby(b.command)) - Number(webby(a.command)) || a.port - b.port);
  return list.slice(0, 60);
}
