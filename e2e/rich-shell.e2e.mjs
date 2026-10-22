#!/usr/bin/env node
/**
 * `!` shell commands in the rich view: shell mode in the composer, output streams into a card, Stop, the
 * exit code, and finished commands riding along with the next message to Claude (or not, if taken off).
 * Isolated; a couple of Haiku calls.
 *
 *   node e2e/rich-shell.e2e.mjs [--keep]
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

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-shell-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-shell-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const env = {
  ...process.env, 
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
try {
  app = await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1300, height: 900 }));
  await waitFor(() => win.$('.daemon-dot.ok'), 'daemon', 20_000);
  daemonPid = (await rpc('snapshot')).daemon.pid;
  const input = `${V} .rv-input`;
  const type = async (t) => { await win.waitForSelector(`${input}:not([disabled])`, { timeout: 30_000 }); await win.fill(input, t); };
  const send = async (t) => { await type(t); await win.press(input, 'Enter'); };
  const cards = () => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-shell`)].map((c) => ({
    cmd: c.querySelector('.rv-shell-cmd').textContent, out: c.querySelector('.rv-shell-out')?.textContent ?? '', cls: c.className,
    exit: c.querySelector('.rv-shell-exit')?.textContent ?? '', foot: c.querySelector('.rv-shell-foot')?.innerText.replace(/\s+/g, ' ') ?? '' })), V);
  const turns = () => win.evaluate((v) => document.querySelectorAll(`${v} .rv-turn`).length, V);
  const text = () => win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText, V);

  const s = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto', name: 'shell' });
  await win.click(`[data-id="${s.id}"]`);

  await soft('typing ! switches the composer to shell mode, and esc leaves it', async () => {
    await type('!');
    await waitFor(async () => (await win.$(`${input}.shell`)) && /shell · runs in/.test(await win.textContent(`${V} .rv-composer-bar`)), 'shell mode', 5000);
    await win.screenshot({ path: join(ART, 'shell-1-mode.png') });
    await win.press(input, 'Escape');
    if ((await win.inputValue(input)) !== '') throw new Error('esc did not clear the shell line');
    return 'ok';
  });

  await soft('a command runs in the session directory and its output lands in a card', async () => {
    await send(`! echo hello-${tag} && pwd`);
    await waitFor(async () => (await cards()).some((c) => /hello-/.test(c.out) && /exit 0/.test(c.exit)), 'the finished card', 15_000);
    const c = (await cards())[0];
    if (!/atlas\s*$/.test(c.out.trim())) throw new Error(`ran in the wrong place: ${c.out}`);
    if (!/goes to Claude with your next message/.test(c.foot)) throw new Error(`footer: ${c.foot}`);
    return c.out.trim().split('\n').join(' | ');
  });

  await soft('a failing command shows its exit code', async () => {
    await send('! ls /definitely/not/here');
    await waitFor(async () => (await cards()).some((c) => /not/.test(c.out) && /exit [1-9]/.test(c.exit) && /fail/.test(c.cls)), 'the failed card', 15_000);
    return (await cards()).at(-1).exit;
  });

  await soft('a running command streams, can be stopped, and does not wait for Claude', async () => {
    await send('! for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo tick $i; sleep 1; done');
    await waitFor(async () => { const c = (await cards()).at(-1); return /running/.test(c.cls) && /tick \d/.test(c.out); }, 'streamed output', 10_000);
    await win.locator(`${V} .rv-shell.running .chip-btn:has-text("Stop")`).click();
    await waitFor(async () => /stopped/.test((await cards()).at(-1).exit), 'stopped', 10_000);
    const out = (await cards()).at(-1).out;
    if (/tick 20/.test(out)) throw new Error('it ran to the end');
    return `stopped after ${out.trim().split('\n').length} lines`;
  });

  await soft('finished commands ride along with your next message to Claude', async () => {
    const n = await turns();
    await send(`! echo MARK-${tag}`);
    await waitFor(async () => (await cards()).some((c) => c.out.includes(`MARK-${tag}`) && /exit 0/.test(c.exit)), 'the marker card', 15_000);
    await send('One of my shell commands printed a MARK-word. Reply with just that word, exactly.');
    await waitFor(async () => (await turns()) > n, 'the turn', 90_000);
    const t = await text();
    const reply = t.split('Reply with just that word, exactly.').pop();
    if (!reply.includes(`MARK-${tag}`)) throw new Error(`Claude did not see the output: ${reply.slice(0, 200)}`);
    const feet = (await cards()).map((c) => c.foot);
    if (!feet.some((f) => /sent to Claude/.test(f))) throw new Error(`footers: ${feet}`);
    await win.screenshot({ path: join(ART, 'shell-2-attached.png') });
    return 'Claude read it';
  });

  await soft('a command you take off is not sent', async () => {
    await send(`! echo SECRET-${tag}`);
    await waitFor(async () => (await cards()).some((c) => c.out.includes(`SECRET-${tag}`) && /exit 0/.test(c.exit)), 'the secret card', 15_000);
    await win.locator(`${V} .rv-shell:has-text("SECRET-${tag}") .chip-btn:has-text("Don't attach")`).click();
    const n = await turns();
    await send('Reply with just the word PLAIN.');
    await waitFor(async () => (await turns()) > n, 'the turn', 90_000);
    const bubbles = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-user`)].map((e) => e.textContent), V);
    if (bubbles.some((b) => b.includes(`SECRET-${tag}`) && /PLAIN/.test(b))) throw new Error('the dismissed output went to Claude');
    return 'not attached';
  });

  await soft('a command runs while Claude is working', async () => {
    const n = await turns();
    await send('Run this exact Bash command: python3 -c "import time; time.sleep(12)" and then reply with just SLOWDONE.');
    await win.waitForSelector(`${V} .rv-work .rv-dot.running, ${V} .rv-tool.running`, { timeout: 60_000 });
    await send('! echo during-turn');
    await waitFor(async () => (await cards()).some((c) => /during-turn/.test(c.out) && /exit 0/.test(c.exit)), 'the card during the turn', 10_000);
    if ((await turns()) > n) throw new Error('the turn had already ended, so this proved nothing');
    await waitFor(async () => (await turns()) > n, 'the turn to end', 90_000);
    return 'ok';
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
