import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { ACTIVE_WINDOW_MS, type RpcMethod, type RpcParams, type RpcResult, type SessionInfo } from '@jarvis/protocol';
import { daemonSocketPath, jarvisHome } from '@jarvis/protocol/node';

const LABEL = 'dev.jarvis.jarvisd';
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const HOME = jarvisHome();
const SOCK = daemonSocketPath();

function daemonBundle(): string {
  return process.env.JARVIS_DAEMON_BUNDLE || resolve(__dirname, '../../../packages/daemon/dist/jarvisd.cjs');
}

function rpc<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
  return new Promise((res, rej) => {
    const req = request({ socketPath: SOCK, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => {
        try {
          const out = JSON.parse(body);
          if (out.error) rej(new Error(out.error.message));
          else res(out.result);
        } catch (e) {
          rej(e);
        }
      });
    });
    req.on('error', rej);
    req.end(JSON.stringify({ method, params }));
  });
}

async function alive(): Promise<boolean> {
  try {
    await rpc('daemon.info');
    return true;
  } catch {
    return false;
  }
}

const uid = userInfo().uid;
/** The launchd agent serves the default home only; a custom JARVIS_HOME always gets its own daemon. */
const launchdLoaded = () =>
  !process.env.JARVIS_HOME && spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }).status === 0;

async function ensureDaemon(): Promise<void> {
  if (await alive()) return;
  if (launchdLoaded()) {
    spawnSync('launchctl', ['kickstart', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  } else {
    const bundle = daemonBundle();
    if (!existsSync(bundle)) throw new Error(`daemon bundle missing: ${bundle} (run pnpm build in ~/jarvis)`);
    mkdirSync(join(HOME, 'logs'), { recursive: true });
    const out = openSync(join(HOME, 'logs', 'jarvisd.log'), 'a');
    spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bundle], { detached: true, stdio: ['ignore', out, out] }).unref();
  }
  for (let i = 0; i < 50; i++) {
    if (await alive()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jarvisd did not start; see ${join(HOME, 'logs', 'jarvisd.log')}`);
}

function ago(ms: number | null): string {
  if (!ms) return '-';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

async function findSession(q: string): Promise<SessionInfo> {
  const snap = await rpc('snapshot');
  const exact = snap.sessions.find((s) => s.id === q || s.tmuxName === q || s.name === q);
  if (exact) return exact;
  const lq = q.toLowerCase();
  const matches = snap.sessions.filter((s) => s.name.toLowerCase().includes(lq) || s.id.startsWith(lq));
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) throw new Error(`no session matches "${q}"`);
  throw new Error(`"${q}" is ambiguous: ${matches.map((m) => `${m.id} (${m.name})`).join(', ')}`);
}

function parseFlags(args: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k!] = v;
      else if (args[i + 1] && !args[i + 1]!.startsWith('-')) flags[k!] = args[++i]!;
      else flags[k!] = true;
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = args[i + 1] && !args[i + 1]!.startsWith('-') ? args[++i]! : true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function plistXml(node: string, bundle: string): string {
  const path = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const log = join(HOME, 'logs', 'jarvisd.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${bundle}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path}</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

async function daemonCmd(sub: string | undefined): Promise<void> {
  switch (sub) {
    case 'status': {
      if (!(await alive())) {
        console.log(`jarvisd: not running (socket ${SOCK})${launchdLoaded() ? ', launchd agent loaded' : ''}`);
        process.exitCode = 1;
        return;
      }
      const i = await rpc('daemon.info');
      console.log(`jarvisd ${i.version} pid ${i.pid}, up ${ago(i.startedAt)}, tmux -L ${i.tmuxSocket}, home ${i.home}, launchd ${launchdLoaded() ? 'yes' : 'no'}`);
      return;
    }
    case 'start':
      await ensureDaemon();
      console.log('jarvisd running');
      return;
    case 'stop':
      if (await alive()) await rpc('daemon.shutdown');
      console.log('jarvisd stopped (tmux sessions keep running)');
      return;
    case 'restart':
      if (await alive()) await rpc('daemon.shutdown');
      for (let i = 0; i < 30 && (await alive()); i++) await new Promise((r) => setTimeout(r, 100));
      await ensureDaemon();
      console.log('jarvisd restarted');
      return;
    case 'install': {
      if (process.env.JARVIS_HOME) throw new Error('launchd install is only for the default ~/.jarvis home; unset JARVIS_HOME');
      const bundle = daemonBundle();
      if (!existsSync(bundle)) throw new Error(`daemon bundle missing: ${bundle} (run pnpm build in ~/jarvis)`);
      mkdirSync(join(HOME, 'logs'), { recursive: true });
      if (await alive()) await rpc('daemon.shutdown');
      if (launchdLoaded()) spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
      writeFileSync(PLIST, plistXml(process.execPath, bundle));
      const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr}`);
      for (let i = 0; i < 50 && !(await alive()); i++) await new Promise((res) => setTimeout(res, 100));
      console.log(`installed ${PLIST}\nnode: ${process.execPath}\nRe-run \`jarvis daemon install\` if you switch Node versions.`);
      return;
    }
    case 'uninstall':
      if (launchdLoaded()) spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
      if (existsSync(PLIST)) unlinkSync(PLIST);
      console.log('launchd agent removed (tmux sessions keep running)');
      return;
    case 'logs': {
      const f = join(HOME, 'logs', 'jarvisd.log');
      if (existsSync(f)) process.stdout.write(readFileSync(f, 'utf8').split('\n').slice(-60).join('\n'));
      return;
    }
    default:
      console.log('usage: jarvis daemon status|start|stop|restart|install|uninstall|logs');
  }
}

const HELP = `jarvis - client for jarvisd

  jarvis ls [--all] [--json]          list sessions grouped by repo
  jarvis new [dir] [--agent ID] [--model M] [--name N] [--attach]
  jarvis agents                       agents Jarvis can launch (built-in + ~/.jarvis/agents.json)
  jarvis attach <session>             attach in this terminal (tmux)
  jarvis send <session> <text...> [--no-enter]
  jarvis capture <session> [-n LINES]
  jarvis revive <session>             restart an exited session (claude resumes)
  jarvis kill <session>               end the process, keep it in the list
  jarvis rm <session>                 end it and remove it from the list
  jarvis rename <session> <name>
  jarvis repos                        repos the new-session picker offers
  jarvis daemon status|start|stop|restart|install|uninstall|logs

<session> is an id, tmux name, or a unique part of the session name.`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseFlags(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return void console.log(HELP);
  if (cmd === 'daemon') return daemonCmd(pos[0]);
  await ensureDaemon();
  switch (cmd) {
    case 'ls': {
      const snap = await rpc('snapshot');
      if (flags.json) return void console.log(JSON.stringify(snap, null, 2));
      for (const ws of snap.workspaces) {
        const rows = snap.sessions.filter((s) => s.repoRoot === ws.root && (flags.all || !s.hidden));
        if (!rows.length) continue;
        console.log(`\n${ws.name}  ${ws.root.replace(homedir(), '~')}`);
        for (const s of rows) {
          const working = s.status === 'running' && s.lastActivity && Date.now() - s.lastActivity < ACTIVE_WINDOW_MS;
          const dot = s.status === 'exited' ? 'x' : working ? '*' : 'o';
          const model = s.model ? `/${s.model}` : '';
          console.log(`  ${dot} ${s.id.padEnd(14)} ${s.name.slice(0, 28).padEnd(28)} ${(s.agent + model).padEnd(16)} ${(s.branch ?? '').slice(0, 24).padEnd(24)} ${ago(s.lastActivity)}${s.hidden ? '  (hidden)' : ''}`);
        }
      }
      return;
    }
    case 'new': {
      const s = await rpc('sessions.create', {
        cwd: resolve(pos[0] ?? process.cwd()),
        agent: typeof flags.agent === 'string' ? flags.agent : 'claude',
        model: typeof flags.model === 'string' ? flags.model : null,
        name: typeof flags.name === 'string' ? flags.name : null,
      });
      console.log(`${s.id}  ${s.name}  (${s.tmuxName})`);
      if (flags.attach) return attach(s.id);
      return;
    }
    case 'attach':
      return attach((await findSession(need(pos[0], 'session'))).id);
    case 'send': {
      const s = await findSession(need(pos[0], 'session'));
      await rpc('sessions.sendKeys', { id: s.id, text: pos.slice(1).join(' '), enter: !flags['no-enter'] });
      return;
    }
    case 'capture': {
      const s = await findSession(need(pos[0], 'session'));
      const { text } = await rpc('sessions.capture', { id: s.id, lines: Number(flags.n) || 200 });
      return void process.stdout.write(text);
    }
    case 'revive': {
      const s = await rpc('sessions.revive', { id: (await findSession(need(pos[0], 'session'))).id });
      return void console.log(`${s.id} running`);
    }
    case 'kill':
      await rpc('sessions.kill', { id: (await findSession(need(pos[0], 'session'))).id });
      return;
    case 'rm':
      await rpc('sessions.remove', { id: (await findSession(need(pos[0], 'session'))).id });
      return;
    case 'rename':
      await rpc('sessions.rename', { id: (await findSession(need(pos[0], 'session'))).id, name: pos.slice(1).join(' ') });
      return;
    case 'agents': {
      for (const a of await rpc('agents.list', { refresh: true })) {
        const status = a.available ? (a.path ?? '') : 'not installed';
        console.log(`${(a.glyph ?? ' ').padEnd(2)} ${a.id.padEnd(10)} ${a.label.padEnd(14)} ${a.source === 'user' ? 'user ' : '     '} ${status}`);
      }
      console.log(`\nAdd or override agents in ${join(HOME, 'agents.json')}`);
      return;
    }
    case 'repos':
      for (const r of await rpc('repos.list')) console.log(`${r.name.padEnd(40)} ${(r.branch ?? '').padEnd(28)} ${r.path.replace(homedir(), '~')}`);
      return;
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

async function attach(id: string): Promise<void> {
  const spec = await rpc('sessions.attachSpec', { id });
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const r = spawnSync(spec.file, spec.args, { stdio: 'inherit', env });
  process.exitCode = r.status ?? 0;
}

main().catch((e) => {
  console.error(`jarvis: ${(e as Error).message}`);
  process.exitCode = 1;
});
