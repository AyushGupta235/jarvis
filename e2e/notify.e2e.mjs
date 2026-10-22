#!/usr/bin/env node
/**
 * Sounds and notifications when an agent finishes or needs you: Jarvis's own sound plays for each, the menu
 * switches them off and the choice is saved. Isolated; a few Haiku calls. (The test records sounds in a file
 * instead of playing them.)
 *
 *   node e2e/notify.e2e.mjs [--keep]
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = require('playwright');
const KEEP = process.argv.includes('--keep');

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-notify-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-notify-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const SOUNDS = join(tmp, 'sounds.log');
const env = {
  ...process.env, JARVIS_SOUND_LOG: SOUNDS,
  JARVIS_HOME: join(tmp, 'home'), JARVIS_TMUX_SOCKET: SOCKET, JARVIS_REPO_ROOTS: join(tmp, 'repos'),
  JARVIS_USER_DATA: join(tmp, 'electron'), JARVIS_NO_EXTERNAL: '1', JARVIS_NO_PRS: '1', JARVIS_NO_USAGE: '1', JARVIS_CLAUDE_HOME: join(homedir(), '.claude'),
};
for (const k of Object.keys(env)) if (/^(CLAUDE|CLAUDECODE|TMUX|ANTHROPIC_API_KEY)/.test(k)) delete env[k];
const repo = join(tmp, 'repos', 'atlas');
mkdirSync(join(repo, 'docs'), { recursive: true });
writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nThe atlas guide lives here.\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
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
const soft = async (name, fn) => {
  try {
    const d = await fn();
    check(name, true, typeof d === 'string' ? d : '');
  } catch (e) {
    check(name, false, e.message.split('\n')[0].slice(0, 220));
    await win.screenshot({ path: join(ART, `agents-fail-${results.length}.png`) }).catch(() => {});
  }
};

let app;
let win;
let daemonPid = null;
const V = '.rich-wrap:not([style*="none"])';
const rpc = (m, p) => win.evaluate(([m, p]) => window.jarvis.rpc(m, p), [m, p]);
const played = () => (existsSync(SOUNDS) ? readFileSync(SOUNDS, 'utf8').split('\n').filter(Boolean) : []);
try {
  app = await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1300, height: 800 }));
  await waitFor(() => win.$('.daemon-dot.ok'), 'daemon', 20_000);
  daemonPid = (await rpc('snapshot')).daemon.pid;
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  const send = async (t) => { await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30_000 }); await win.fill(`${V} .rv-input`, t); await win.press(`${V} .rv-input`, 'Enter'); };
  const turns = () => win.evaluate((v) => document.querySelectorAll(`${v} .rv-turn`).length, V);
  const turn = async (t) => { const n = await turns(); await send(t); await waitFor(async () => (await turns()) > n, 'the turn', 90_000); };
  const menuItem = (label) => app.evaluate(({ Menu }, label) => {
    const find = (items) => { for (const i of items) { if (i.label === label) return i; if (i.submenu) { const f = find(i.submenu.items); if (f) return f; } } return null; };
    const i = find(Menu.getApplicationMenu().items);
    return i ? { checked: i.checked } : null;
  }, label);
  const clickItem = (label) => app.evaluate(({ Menu }, label) => {
    const find = (items) => { for (const i of items) { if (i.label === label) return i; if (i.submenu) { const f = find(i.submenu.items); if (f) return f; } } return null; };
    find(Menu.getApplicationMenu().items).click();
  }, label);

  const s = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto', name: 'notify' });
  await win.click(`[data-id="${s.id}"]`);

  await soft('Jarvis plays its own sound each time an agent finishes', async () => {
    await turn('Reply with just ONE.');
    await waitFor(() => played().filter((x) => x === 'done').length >= 1, 'the sound', 15_000, 300);
    await sleep(1500);
    await turn('Reply with just TWO.');
    await waitFor(() => played().filter((x) => x === 'done').length >= 2, 'a second sound', 15_000, 300);
    return `${played().length} sounds`;
  });

  await soft('the sounds are real audio files in the app data folder', async () => {
    const files = ['done-v1.wav', 'needs-v1.wav'].map((f) => join(userData, 'sounds', f));
    const done = files[0];
    if (!existsSync(done)) throw new Error('no done sound file');
    const b = readFileSync(done);
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.length < 40_000) throw new Error(`not a sound: ${b.length} bytes`);
    return `${b.length} bytes`;
  });

  await soft('an agent that needs you has a different sound', async () => {
    const d = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'default', name: 'asks' });
    await win.click(`[data-id="${d.id}"]`);
    const extra = join(tmp, 'extra');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'note.txt'), 'hello');
    await send(`Use the Read tool on ${extra}/note.txt and tell me what it says.`);
    await win.waitForSelector(`${V} .rv-perm`, { timeout: 90_000 });
    await waitFor(() => played().includes('needs'), 'the needs-you sound', 15_000, 300);
    await win.click(`${V} .rv-perm .btn:has-text("Deny")`);
    await win.click(`[data-id="${s.id}"]`);
    return 'needs-you sound played';
  });

  await soft('the menu switches the finished sound off, the choice is saved, and switching it on brings it back', async () => {
    const label = 'Sound when an agent finishes';
    if (!(await menuItem(label))?.checked) throw new Error('the item is not on by default');
    await clickItem(label);
    await waitFor(async () => !(await menuItem(label))?.checked, 'the item to turn off', 5000);
    const saved = JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8'));
    if (saved.soundDone !== false) throw new Error(`prefs: ${JSON.stringify(saved)}`);
    await sleep(1500);
    const before = played().filter((x) => x === 'done').length;
    await turn('Reply with just THREE.');
    await sleep(3000);
    if (played().filter((x) => x === 'done').length !== before) throw new Error('a sound played with it switched off');
    await clickItem(label);
    await sleep(1500);
    await turn('Reply with just FOUR.');
    await waitFor(() => played().filter((x) => x === 'done').length > before, 'the sound again', 15_000, 300);
    return 'off then on';
  });
} catch (e) {
  console.error(e);
  check('run completed', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  if (daemonPid) try { process.kill(daemonPid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1500);
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}
