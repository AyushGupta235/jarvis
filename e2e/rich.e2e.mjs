#!/usr/bin/env node
/**
 * R0 acceptance test for rich sessions (RICH-VIEW.md): a Claude session driven through the Agent SDK
 * survives quitting Jarvis, restarting jarvisd, and its host being killed (revive resumes it from the
 * transcript). Runs against an isolated JARVIS_HOME, tmux socket and Electron profile, with Haiku.
 *
 *   node e2e/rich.e2e.mjs [--packaged] [--keep]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = require('playwright');

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const PACKAGED = args.includes('--packaged');
const APP_BIN = join(DESKTOP, 'release/mac-arm64/Jarvis.app/Contents/MacOS/Jarvis');

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-rich-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-rich-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const env = {
  ...process.env,
  JARVIS_HOME: join(tmp, 'home'),
  JARVIS_TMUX_SOCKET: SOCKET,
  JARVIS_REPO_ROOTS: join(tmp, 'repos'),
  JARVIS_USER_DATA: join(tmp, 'electron'),
  JARVIS_NO_EXTERNAL: '1',
  JARVIS_NO_PRS: '1',
  JARVIS_NO_USAGE: '1',
};
for (const k of Object.keys(env)) if (/^(CLAUDE|CLAUDECODE|TMUX|ANTHROPIC_API_KEY)/.test(k)) delete env[k];

const repo = join(tmp, 'repos', 'atlas');
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, 'README.md'), '# atlas\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e2e@jarvis', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'init'], { cwd: repo });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[rich ${new Date().toISOString().slice(11, 19)}]`, ...a);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const rssMb = (pid) => {
  try {
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024);
  } catch {
    return null;
  }
};
const childrenOf = (pid) => {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

async function waitFor(fn, what, timeout = 60_000, every = 400) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function launch() {
  const app = PACKAGED
    ? await electron.launch({ executablePath: APP_BIN, args: [], env })
    : await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 60, y: 40, width: 1360, height: 860 }));
  await waitFor(() => win.evaluate(() => document.querySelector('.daemon-dot.ok') !== null), 'daemon connection', 20_000);
  return { app, win };
}

const menu = (app, action, arg) =>
  app.evaluate(({ BrowserWindow }, [a, x]) => BrowserWindow.getAllWindows()[0].webContents.send('menu', a, x), [action, arg]);
const snapshot = (win) => win.evaluate(() => window.jarvis.rpc('snapshot'));
const sessionOf = async (win, id) => (await snapshot(win)).sessions.find((s) => s.id === id);
const richText = (win) => win.evaluate(() => document.querySelector('.rich-wrap:not([style*="none"]) .rv-scroll')?.innerText ?? '');

async function sendViaComposer(win, text) {
  const box = '.rich-wrap:not([style*="none"]) .rv-input';
  await win.waitForSelector(`${box}:not([disabled])`, { timeout: 20_000 });
  await win.fill(box, text);
  await win.press(box, 'Enter');
}

/** The newest assistant text in the visible rich view. */
const lastReply = (win) => win.evaluate(() => {
  const t = [...document.querySelectorAll('.rich-wrap:not([style*="none"]) .rv-text')];
  return t.at(-1)?.textContent ?? '';
});

let app;
let win;
let daemonPid = null;
const hostPids = new Set();
try {
  log(`tmp ${tmp}, tmux -L ${SOCKET}`);
  ({ app, win } = await launch());
  daemonPid = (await snapshot(win)).daemon.pid;

  // 1. The new-session picker offers the rich view for Claude, and creating one works.
  await menu(app, 'new-session');
  await win.waitForSelector('.modal .modal-input', { timeout: 5000 });
  await win.fill('.modal .modal-input', 'atlas');
  await win.click('.seg-btn:text-is("Claude")');
  await win.click('.seg-btn:text-is("Haiku")');
  const hasToggle = await win.$('.seg-btn:text-is("Rich (SDK)")');
  check('picker shows the Terminal / Rich toggle for Claude', !!hasToggle);
  await win.click('.seg-btn:text-is("Rich (SDK)")');
  await win.click('.modal .btn.primary');
  const viaUi = await waitFor(async () => (await snapshot(win)).sessions.find((s) => s.mode === 'rich'), 'rich session from the picker', 30_000);
  await waitFor(async () => (await sessionOf(win, viaUi.id))?.rich?.connected, 'picker session connected', 30_000);
  check('picker creates a rich session with a running host', true, `host ${(await sessionOf(win, viaUi.id)).rich.hostPid}`);
  await win.waitForSelector('.rich-wrap .rv-input', { timeout: 10_000 });
  check('rich session renders the rich view, not a terminal', !(await win.$('.term-wrap:not([style*="none"]) .xterm')));

  // 2. A second rich session with default permissions, so tool use asks first.
  const s = await win.evaluate((cwd) => window.jarvis.rpc('sessions.create', {
    cwd, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'default', name: 'rich-e2e',
  }), repo);
  await win.click(`[data-id="${s.id}"]`);
  const first = await sessionOf(win, s.id);
  check('rich session is running with a host process', first.status === 'running' && !!first.rich?.hostPid, `host ${first.rich?.hostPid}`);
  hostPids.add(first.rich.hostPid);
  hostPids.add((await sessionOf(win, viaUi.id)).rich.hostPid);

  const WORD = `PINEAPPLE${tag.toUpperCase()}`;
  await sendViaComposer(win, `Reply with exactly the word ${WORD} and nothing else.`);
  await waitFor(async () => (await lastReply(win)).includes(WORD), 'first reply', 90_000);
  check('composer sends a prompt and the reply renders', true);
  const text1 = await richText(win);
  check('status line shows the plan login, not an API key', /on your Claude plan/.test(text1), text1.match(/haiku[^\n]*/i)?.[0] ?? '');

  await sendViaComposer(win, 'Use the Write tool to create notes.txt containing the single word hello. Then reply with exactly WROTE.');
  await win.waitForSelector('.rv-perm .btn.primary', { timeout: 90_000 });
  const needs = await waitFor(async () => (await sessionOf(win, s.id))?.agentState?.phase === 'needs_input', 'needs-you state', 10_000).catch(() => false);
  check('a permission request puts the session in "needs you"', !!needs);
  await win.click('.rv-perm .btn.primary');
  await waitFor(() => existsSync(join(repo, 'notes.txt')), 'notes.txt', 60_000);
  await waitFor(async () => (await lastReply(win)).includes('WROTE'), 'WROTE reply', 60_000);
  check('Allow in the permission card lets the tool run', readFileSync(join(repo, 'notes.txt'), 'utf8').includes('hello'));
  check('tool call renders as a Write row', await win.evaluate(() => [...document.querySelectorAll('.rv-tool-name')].some((e) => e.textContent === 'Write')));
  await waitFor(async () => (await win.evaluate((id) => window.jarvis.rpc('activity.list', { id, limit: 50 }), s.id)).some((e) => e.tool === 'Write'), 'activity entry', 15_000)
    .then(() => check('hooks feed the Activity tab for rich sessions too', true))
    .catch(() => check('hooks feed the Activity tab for rich sessions too', false));
  await win.screenshot({ path: join(ART, 'rich-1-live.png') });

  const host = (await sessionOf(win, s.id)).rich.hostPid;
  const claudeKids = childrenOf(host);
  log(`host ${host} rss ${rssMb(host)} MB, claude ${claudeKids.join(',')} rss ${claudeKids.map(rssMb).join(',')} MB`);

  // 3. Quit Jarvis: the host keeps running; relaunch reattaches with history.
  await app.close();
  await sleep(1500);
  check('host survives quitting Jarvis', alive(host));
  ({ app, win } = await launch());
  await win.click(`[data-id="${s.id}"]`);
  const after = await waitFor(async () => {
    const x = await sessionOf(win, s.id);
    return x?.rich?.connected ? x : null;
  }, 'reconnected after relaunch', 20_000);
  check('relaunch reconnects to the same host', after.rich.hostPid === host, `host ${after.rich.hostPid}`);
  await waitFor(async () => (await richText(win)).includes(WORD), 'history after relaunch', 10_000)
    .then(() => check('history renders after relaunch', true))
    .catch(() => check('history renders after relaunch', false));

  // 4. Restart jarvisd: hosts keep running, the new daemon reconnects.
  daemonPid = (await snapshot(win)).daemon.pid;
  process.kill(daemonPid, 'SIGTERM');
  await waitFor(async () => {
    const snap = await snapshot(win).catch(() => null);
    return snap && snap.daemon.pid !== daemonPid ? snap : null;
  }, 'a new jarvisd', 30_000);
  daemonPid = (await snapshot(win)).daemon.pid;
  const re = await waitFor(async () => {
    const x = await sessionOf(win, s.id);
    return x?.rich?.connected ? x : null;
  }, 'reconnected after daemon restart', 20_000);
  check('host survives a jarvisd restart and reconnects', re.rich.hostPid === host && alive(host), `daemon ${daemonPid}`);
  await sendViaComposer(win, 'What exact word did I first ask you to reply with? Reply with just that word.');
  await waitFor(async () => (await win.evaluate(() => [...document.querySelectorAll('.rich-wrap:not([style*="none"]) .rv-text')].length)) >= 3 &&
    (await lastReply(win)).includes(WORD), 'recall after daemon restart', 90_000);
  check('the same live conversation continues after the restart', true);

  // 5. Kill the host outright: the session ends, revive resumes it from the transcript.
  process.kill(host, 'SIGKILL');
  await waitFor(async () => (await sessionOf(win, s.id))?.status === 'exited', 'exited after host kill', 15_000);
  check('killing the host ends the session', true);
  await sleep(2000);
  check('the killed host leaves no claude process behind', claudeKids.every((p) => !alive(p)), claudeKids.join(','));
  await win.waitForSelector('.term-overlay .btn.primary', { timeout: 10_000 });
  await win.click('.term-overlay .btn.primary');
  const revived = await waitFor(async () => {
    const x = await sessionOf(win, s.id);
    return x?.rich?.connected ? x : null;
  }, 'revived', 30_000);
  hostPids.add(revived.rich.hostPid);
  check('revive starts a new host', revived.rich.hostPid !== host, `host ${revived.rich.hostPid}`);
  await waitFor(async () => /resumed · \d+ messages/.test(await richText(win)) && (await richText(win)).includes(WORD), 'replayed history', 15_000)
    .then(() => check('revived session shows the old conversation from the transcript', true))
    .catch(() => check('revived session shows the old conversation from the transcript', false));
  const beforeTexts = await win.evaluate(() => document.querySelectorAll('.rich-wrap:not([style*="none"]) .rv-text').length);
  await sendViaComposer(win, 'Repeat the exact word from my very first message. Reply with just that word.');
  await waitFor(async () => (await win.evaluate(() => document.querySelectorAll('.rich-wrap:not([style*="none"]) .rv-text').length)) > beforeTexts &&
    (await lastReply(win)).includes(WORD), 'recall after revive', 90_000);
  check('revived session remembers the conversation (resume)', true);
  const lastStatus = await win.evaluate(() => [...document.querySelectorAll('.rich-wrap:not([style*="none"]) .rv-note')].map((e) => e.textContent).filter((t) => /permissions/.test(t)).at(-1) ?? '');
  check('revive keeps the permission mode the session started with', /default permissions/.test(lastStatus), lastStatus);
  await win.screenshot({ path: join(ART, 'rich-2-revived.png') });

  // 6. The transcript is Claude's own, so the terminal can resume the same conversation.
  const projDirs = readdirSync(join(homedir(), '.claude/projects')).filter((d) => d.includes(`jarvis-rich-${tag}`));
  const transcript = projDirs.map((d) => join(homedir(), '.claude/projects', d, `${s.agentSessionId}.jsonl`)).find(existsSync);
  check('the conversation is a normal Claude transcript (claude --resume works on it)', !!transcript, transcript ?? 'missing');

  // 7. Stop removes the host.
  await win.evaluate((id) => window.jarvis.rpc('sessions.kill', { id }), s.id);
  await waitFor(() => !alive(revived.rich.hostPid), 'host stopped', 10_000)
    .then(() => check('stopping a rich session stops its host', true))
    .catch(() => check('stopping a rich session stops its host', false));
} catch (e) {
  console.error(e);
  check('run completed', false, e.message.split('\n')[0]);
  if (win) await win.screenshot({ path: join(ART, 'rich-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  if (!KEEP) {
    for (const pid of hostPids) if (pid && alive(pid)) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    if (daemonPid && alive(daemonPid)) try { process.kill(daemonPid, 'SIGTERM'); } catch { /* gone */ }
    try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
    await sleep(2500);
    rmSync(tmp, { recursive: true, force: true });
    const proj = join(homedir(), '.claude/projects');
    for (const d of readdirSync(proj)) if (d.includes(`jarvis-rich-${tag}`)) rmSync(join(proj, d), { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${ART}`);
  process.exit(failed.length ? 1 : 0);
}
