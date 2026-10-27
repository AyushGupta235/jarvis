#!/usr/bin/env node
/**
 * The new-session picker finds every folder: git repos and plain folders under your roots, repos nested in a
 * folder of repos, a folder you create after the app started, and any path you type (with Tab completion and a
 * row that creates a folder that does not exist yet). No agent calls.
 *
 *   node e2e/directories.e2e.mjs [--keep]
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

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-dirs-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-dirs-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const env = {
  ...process.env, 
  JARVIS_HOME: join(tmp, 'home'), JARVIS_TMUX_SOCKET: SOCKET, JARVIS_REPO_ROOTS: `${join(tmp, 'code')}:${join(tmp, 'other')}`,
  JARVIS_USER_DATA: join(tmp, 'electron'), JARVIS_NO_EXTERNAL: '1', JARVIS_NO_PRS: '1', JARVIS_NO_USAGE: '1', JARVIS_CLAUDE_HOME: join(homedir(), '.claude'),
};
for (const k of Object.keys(env)) if (/^(CLAUDE|CLAUDECODE|TMUX|ANTHROPIC_API_KEY)/.test(k)) delete env[k];
const code = join(tmp, 'code');
const other = join(tmp, 'other');
const repo = join(code, 'alpha');
mkdirSync(join(repo, 'docs'), { recursive: true });
writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nThe atlas guide lives here.\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo });
// plain folders, and a folder of repos
mkdirSync(join(code, 'fresh'), { recursive: true });
mkdirSync(join(code, 'team', 'api'), { recursive: true });
execFileSync('git', ['init', '-q', join(code, 'team', 'api')]);
mkdirSync(join(other, 'Documents'), { recursive: true });
mkdirSync(join(other, 'notes'), { recursive: true });

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
const rpc = (m, p) => win.evaluate(([m, p]) => window.jarvis.rpc(m, p), [m, p]);
const menu = (a) => app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0].webContents.send('menu', a), a);
try {
  app = await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1300, height: 900 }));
  await waitFor(() => win.$('.daemon-dot.ok'), 'daemon', 20_000);
  daemonPid = (await rpc('snapshot')).daemon.pid;
  const names = () => win.evaluate(() => [...document.querySelectorAll('.modal .opt .opt-name')].map((e) => { const c = e.cloneNode(true); c.querySelectorAll('.tag').forEach((t) => t.remove()); return c.textContent; }));
  const openDialog = async () => {
    if (await win.$('.modal')) { await win.keyboard.press('Escape'); await win.waitForSelector('.modal', { state: 'detached' }); }
    await menu('new-session');
    await win.waitForSelector('.modal .modal-input');
    await win.waitForSelector('.modal .opt:not(.muted)', { timeout: 10_000 });
  };

  await soft('every folder under your roots is listed, git or not, and repos inside a folder of repos', async () => {
    await openDialog();
    const n = await names();
    for (const want of ['alpha', 'fresh', 'api', 'Documents', 'notes', 'team']) if (!n.some((x) => x.endsWith(want))) throw new Error(`${want} is missing: ${n.join(', ')}`);
    const tagged = await win.evaluate(() => [...document.querySelectorAll('.modal .opt')].map((o) => ({ n: o.querySelector('.opt-name').textContent, folder: !!o.querySelector('.tag') })));
    if (tagged.find((x) => x.n.endsWith('alpha')).folder) throw new Error('a git repo is tagged as a plain folder');
    if (!tagged.find((x) => x.n.endsWith('fresh')).folder) throw new Error('a plain folder is not tagged');
    await win.screenshot({ path: join(ART, 'dirs-1-list.png') });
    return n.join(', ');
  });

  await soft('a folder created after the app started shows up the next time you open the picker', async () => {
    mkdirSync(join(code, 'brandnew'));
    await openDialog();
    if (!(await names()).some((x) => x.endsWith('brandnew'))) throw new Error(`not listed: ${(await names()).join(', ')}`);
    return 'brandnew';
  });

  await soft('typing a path lists the folders there, anywhere on disk, and Tab completes it', async () => {
    await openDialog();
    await win.fill('.modal .modal-input', `${other}/`);
    await waitFor(async () => { const n = await names(); return n.includes('Documents') && n.includes('notes') && !n.includes('alpha'); }, 'the folders in other/', 5000);
    await win.fill('.modal .modal-input', `${tmp}/ot`);
    await waitFor(async () => (await names()).includes('other'), 'a prefix match', 5000);
    await win.press('.modal .modal-input', 'Tab');
    await waitFor(async () => (await win.inputValue('.modal .modal-input')).endsWith('/other/'), 'Tab to complete', 5000);
    return 'ok';
  });

  await soft('a folder that does not exist can be created and started in', async () => {
    await openDialog();
    const dir = join(other, 'newproj', 'deep');
    await win.fill('.modal .modal-input', dir);
    await waitFor(async () => (await names()).some((x) => /^Create/.test(x)), 'the create row', 5000);
    // the shell agent keeps this quick
    await win.click('.seg-btn:text-is("Shell")');
    await win.press('.modal .modal-input', 'Enter');
    const s = await waitFor(async () => (await rpc('snapshot')).sessions.find((x) => x.cwd === dir), 'the session', 15_000);
    if (!existsSync(dir)) throw new Error('the folder was not created');
    return s.cwd.replace(tmp, '…');
  });

  await soft('a second session in a plain folder starts there; no worktree is offered (there is no repo)', async () => {
    const fresh = join(code, 'fresh');
    await rpc('sessions.create', { cwd: fresh, agent: 'shell', mode: 'terminal', name: 'first' });
    await openDialog();
    await win.fill('.modal .modal-input', `${code}/fr`);
    await waitFor(async () => (await names()).includes('fresh'), 'the folder', 5000);
    await win.click('.seg-btn:text-is("Claude")');
    await sleep(400);
    if (await win.$('.modal .shared-note')) throw new Error('a Checkout choice is offered for a plain folder');
    await win.click('.seg-btn:text-is("Terminal")');
    await win.press('.modal .modal-input', 'Enter');
    await waitFor(async () => (await rpc('snapshot')).sessions.filter((x) => x.cwd === fresh).length === 2, 'the second session', 15_000);
    if (await win.$('.modal-error')) throw new Error('an error showed');
    return 'two sessions in the folder';
  });

  await soft('clicking a folder selects it and waits; Start (or a double-click) begins the session', async () => {
    await openDialog();
    await win.fill('.modal .modal-input', `${code}/`);
    await waitFor(async () => (await names()).includes('brandnew'), 'the folders', 5000);
    const before = (await rpc('snapshot')).sessions.length;
    await win.click('.seg-btn:text-is("Shell")');
    await win.click('.modal .opt:has-text("brandnew")');
    await sleep(1500);
    if ((await rpc('snapshot')).sessions.length !== before) throw new Error('a single click started a session');
    const sel = await win.evaluate(() => document.querySelector('.modal .opt.sel .opt-name')?.textContent ?? '');
    if (!/brandnew/.test(sel)) throw new Error(`selected: ${sel}`);
    await win.click('.modal .btn.primary');
    await waitFor(async () => (await rpc('snapshot')).sessions.some((x) => x.cwd === join(code, 'brandnew')), 'the session', 15_000);
    await openDialog();
    await win.fill('.modal .modal-input', `${code}/`);
    await waitFor(async () => (await names()).includes('fresh'), 'the folders', 5000);
    const n = (await rpc('snapshot')).sessions.length;
    await win.dblclick('.modal .opt:has-text("fresh")');
    await waitFor(async () => (await rpc('snapshot')).sessions.length === n + 1, 'a double-click to start', 15_000);
    return 'click selects, Start and double-click begin';
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
