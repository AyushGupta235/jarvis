#!/usr/bin/env node
/**
 * Files the agent mentions open from the conversation wherever they are (outside the session folder, dotfiles like
 * .env, plain text as well as `code`, relative to the repo root), and the viewer can edit and save them, with a
 * warning when the file changed on disk meanwhile. One Haiku call.
 *
 *   node e2e/file-links.e2e.mjs [--keep]
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

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-filelinks-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-filelinks-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const env = {
  ...process.env,
  JARVIS_HOME: join(tmp, 'home'), JARVIS_TMUX_SOCKET: SOCKET, JARVIS_REPO_ROOTS: join(tmp, 'repos'),
  JARVIS_USER_DATA: join(tmp, 'electron'), JARVIS_NO_EXTERNAL: '1', JARVIS_NO_PRS: '1', JARVIS_NO_USAGE: '1', JARVIS_CLAUDE_HOME: join(homedir(), '.claude'),
};
for (const k of Object.keys(env)) if (/^(CLAUDE|CLAUDECODE|TMUX|ANTHROPIC_API_KEY)/.test(k)) delete env[k];
const repo = join(tmp, 'repos', 'atlas');
const web = join(repo, 'apps', 'web');
const other = join(tmp, 'elsewhere', 'svc');
mkdirSync(web, { recursive: true });
mkdirSync(other, { recursive: true });
writeFileSync(join(repo, '.env'), 'REPO_KEY=repo\n');
writeFileSync(join(web, 'config.yaml'), 'name: web\n');
writeFileSync(join(other, '.env'), 'API_KEY=old\n');
writeFileSync(join(other, 'notes.txt'), 'OUTSIDE-NOTES\n');
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
    await win.screenshot({ path: join(ART, `filelinks-fail-${results.length}.png`) }).catch(() => {});
  }
};

let app;
let win;
let daemonPid = null;
const V = '.rich-wrap:not([style*="none"])';
const rpc = (m, p) => win.evaluate(([m, p]) => window.jarvis.rpc(m, p), [m, p]);
try {
  app = await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1400, height: 1000 }));
  await waitFor(() => win.$('.daemon-dot.ok'), 'daemon', 20_000);
  daemonPid = (await rpc('snapshot')).daemon.pid;
  const sess = async (id) => (await rpc('snapshot')).sessions.find((x) => x.id === id);
  const text = () => win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText, V);
  const idle = async (id) => waitFor(async () => (await sess(id)).agentState?.phase !== 'working', 'idle', 180_000);
  const cards = () => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-scroll > .rv-column > .rv-agent, ${v} .rv-column > .rv-agent`)].map((c) => ({ head: c.querySelector('.rv-agent-head').innerText.replace(/\s+/g, ' '), cls: c.className, stop: !!c.querySelector('.rv-agent-stop') })), V);

  const tray = () => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-queue-item`)].map((e) => e.innerText.replace(/\s+/g, ' ')), V);
  const send = async (t) => {
    await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30_000 });
    await win.fill(`${V} .rv-input`, t);
    await win.press(`${V} .rv-input`, 'Enter');
  };
  const events = async (id) => (await rpc('rich.history', { id })).events.map((x) => x.event);

  const links = () => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-scroll .pc-path`)].map((e) => e.textContent), V);
  const viewerText = () => win.evaluate(() => document.querySelector('.viewer-scroll')?.innerText ?? '');
  const clickLink = async (text) => { await win.locator(`${V} .rv-scroll .pc-path`).filter({ hasText: text }).first().click(); };

  const s = await rpc('sessions.create', { cwd: web, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto', name: 'links' });
  await win.click(`[data-id="${s.id}"]`);
  await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30000 });
  await win.fill(`${V} .rv-input`, `Reply with exactly these four lines and nothing else, no code fence:
ENV: \`${other}/.env\`
NOTES: ${other}/notes.txt
LOCAL: \`.env\`
CONFIG: \`apps/web/config.yaml\``);
  await win.press(`${V} .rv-input`, 'Enter');
  await waitFor(async () => /CONFIG/.test(await win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText, V)), 'the reply', 90_000);
  await sleep(2500);

  await soft('every file the agent names is a link: outside the folder, plain text, a dotfile, relative to the repo root', async () => {
    await waitFor(async () => (await links()).length >= 4, 'the links', 15_000).catch(() => {});
    const l = await links();
    for (const want of ['.env', 'notes.txt', 'config.yaml']) if (!l.some((x) => x.includes(want))) throw new Error(`no link for ${want}: ${JSON.stringify(l)}`);
    if (l.filter((x) => x.includes('.env')).length < 2) throw new Error(`both .env references should link: ${JSON.stringify(l)}`);
    await win.screenshot({ path: join(ART, 'filelinks-1-links.png') });
    return l.join(' | ').slice(0, 160);
  });

  await soft('clicking the .env outside the session folder opens it', async () => {
    await clickLink(`${other}/.env`);
    await waitFor(async () => /API_KEY=old/.test(await viewerText()), 'the file in the viewer', 8000);
    return 'API_KEY=old';
  });

  await soft('a plain-text path opens, and `.env` and a relative path resolve from the repo root', async () => {
    await clickLink('notes.txt');
    await waitFor(async () => /OUTSIDE-NOTES/.test(await viewerText()), 'notes.txt', 8000);
    await win.locator(`${V} .rv-scroll .pc-path`).filter({ hasText: /^\.env$/ }).first().click();
    await waitFor(async () => /REPO_KEY=repo/.test(await viewerText()), 'the repo .env', 8000);
    await clickLink('apps/web/config.yaml');
    await waitFor(async () => /name: web/.test(await viewerText()), 'config.yaml', 8000);
    return 'ok';
  });

  await soft('edit a .env in the viewer, save, and the file on disk has it', async () => {
    await clickLink(`${other}/.env`);
    await waitFor(async () => /API_KEY=old/.test(await viewerText()), 'the file', 8000);
    await win.click('.viewer-bar button:has-text("Edit")');
    await win.waitForSelector('.viewer-edit');
    await win.fill('.viewer-edit', 'API_KEY=old\nNEW_SECRET=abc123\n');
    await win.click('.viewer-bar button:has-text("Save")');
    await waitFor(() => /NEW_SECRET=abc123/.test(readFileSync(join(other, '.env'), 'utf8')), 'the file on disk', 8000);
    await waitFor(async () => !(await win.$('.viewer-edit')), 'edit mode to close', 5000);
    await waitFor(async () => /NEW_SECRET=abc123/.test(await viewerText()), 'the viewer to show it', 5000);
    return 'saved';
  });

  await soft('saving over a file that changed on disk warns instead of overwriting', async () => {
    await win.click('.viewer-bar button:has-text("Edit")');
    await win.waitForSelector('.viewer-edit');
    await sleep(1100);
    writeFileSync(join(other, '.env'), 'CHANGED_ELSEWHERE=1\n');
    await win.fill('.viewer-edit', 'MINE=1\n');
    await win.click('.viewer-bar button:has-text("Save")');
    await waitFor(async () => /changed on disk/i.test(await win.evaluate(() => document.querySelector('.viewer-body')?.innerText ?? '')), 'the warning', 5000);
    if (!/CHANGED_ELSEWHERE/.test(readFileSync(join(other, '.env'), 'utf8'))) throw new Error('it overwrote the file anyway');
    await win.click('.viewer-body button:has-text("Overwrite")');
    await waitFor(() => /MINE=1/.test(readFileSync(join(other, '.env'), 'utf8')), 'the overwrite', 5000);
    return 'warned, then overwrote on request';
  });
} catch (e) {  console.error(e);
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
