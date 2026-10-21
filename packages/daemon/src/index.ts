import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type DaemonInfo } from '@jarvis/protocol';
import { daemonSocketPath, jarvisHome, tmuxSocketName } from '@jarvis/protocol/node';
import { cleanEnv, findBinary, userShell } from './env';
import { Db } from './db';
import { Tmux, writeTmuxConfs } from './tmux';
import { JarvisService } from './service';
import { AgentRegistry } from './agents';
import { Observers } from './observers';
import { CodexObserver } from './codex';
import { UsageIndexer } from './usage';
import { PrTracker, RemoteCache } from './prs';
import { FileWatcher } from './files';
import { writeIntegration } from './integration';
import { buildHandlers, serve, socketAlive } from './server';
import { log, logError } from './log';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const home = jarvisHome();
  mkdirSync(join(home, 'logs'), { recursive: true });
  const socketPath = daemonSocketPath();

  if (await socketAlive(socketPath)) {
    log(`jarvisd already running on ${socketPath}; exiting`);
    return;
  }

  const env = cleanEnv(process.env);
  const tmuxBin = findBinary('tmux', env);
  if (!tmuxBin) throw new Error('tmux not found on PATH (brew install tmux)');

  const confPath = writeTmuxConfs(home, userShell());
  const socketName = tmuxSocketName();
  const tmux = new Tmux(tmuxBin, socketName, confPath, env);
  const externalTmux = process.env.JARVIS_NO_EXTERNAL ? null : new Tmux(tmuxBin, null, null, env);

  const info: DaemonInfo = {
    version: VERSION, protocol: PROTOCOL_VERSION, pid: process.pid, startedAt: Date.now(),
    tmuxSocket: socketName, tmuxPath: tmuxBin, home,
  };

  const db = new Db(join(home, 'jarvis.db'));
  const repoRoots = (process.env.JARVIS_REPO_ROOTS?.split(':') ?? [join(homedir(), 'code'), homedir()]).filter(Boolean);
  const agents = new AgentRegistry(home, env);
  const integration = writeIntegration(home, socketPath);
  const observers = new Observers(db.raw);
  const codex = new CodexObserver(observers);
  const usage = new UsageIndexer(db.raw, home);
  const prs = new PrTracker(process.env.JARVIS_NO_PRS ? null : findBinary('gh', env), env);
  const files = new FileWatcher();
  const svc = new JarvisService({
    db, tmux, externalTmux, info, repoRoots, agents, observers, codex, usage, prs, remotes: new RemoteCache(), files,
    claudeSettings: integration.claudeSettings, socketPath, env,
  });

  let server: Awaited<ReturnType<typeof serve>> | null = null;
  const shutdown = async (): Promise<void> => {
    log('shutting down (tmux sessions keep running)');
    svc.stop();
    codex.stop();
    prs.stop();
    files.close();
    await server?.close();
    db.close();
    process.exit(0);
  };

  server = await serve(socketPath, svc, buildHandlers(svc, () => void shutdown()), observers);
  svc.start();
  codex.start();
  prs.start();
  if (!process.env.JARVIS_NO_USAGE) usage.start();
  setInterval(() => observers.prune(), 3_600_000);
  void agents.refresh(true).then((list) => {
    log(`agents: ${list.map((a) => `${a.id}${a.available ? '' : ' (missing)'}`).join(', ')}`);
    svc.publish();
  });
  log(`jarvisd ${VERSION} pid ${process.pid} tmux=${tmuxBin} -L ${socketName}`);

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
