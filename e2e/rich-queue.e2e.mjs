#!/usr/bin/env node
/**
 * The rich view's held queue (edit, remove, send now, stop) and the plan-limit bars fed by rich sessions.
 * Isolated; a few Haiku calls.
 *
 *   node e2e/rich-queue.e2e.mjs [--keep]
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = require('playwright');
const KEEP = process.argv.includes('--keep');

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-queue-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-queue-${process.pid}`;
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1400, height: 900 }));
  await waitFor(() => win.$('.daemon-dot.ok'), 'daemon', 20_000);
  daemonPid = (await rpc('snapshot')).daemon.pid;
  const turns = () => win.evaluate((v) => document.querySelectorAll(`${v} .rv-turn`).length, V);
  const text = () => win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText, V);
  const send = async (t) => {
    await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30_000 });
    await win.fill(`${V} .rv-input`, t);
    await win.press(`${V} .rv-input`, 'Enter');
  };
  const items = () => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-queue-item .rv-queue-text, ${v} .rv-queue-item .rv-queue-edit`)].map((e) => e.value ?? e.textContent), V);
  const idle = async () => { await waitFor(async () => (await rpc('snapshot')).sessions[0].agentState?.phase !== 'working', 'idle', 120_000); };

  const s = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto', name: 'queue' });
  await win.click(`[data-id="${s.id}"]`);

  await soft('plan limits come from a rich session and the bars show them', async () => {
    if ((await rpc('snapshot')).limits.claude.fiveHour) throw new Error('limits were already set in a fresh home');
    const t0 = await turns();
    await send('Reply with just OK.');
    await waitFor(async () => (await turns()) > t0, 'the turn', 90_000);
    const l = (await rpc('snapshot')).limits.claude;
    if (!l.fiveHour || !l.sevenDay) throw new Error(`limits: ${JSON.stringify(l)}`);
    if (l.fiveHour.resetsAt < Date.now() || Date.now() - l.asOf > 120_000) throw new Error(`stale: ${JSON.stringify(l)}`);
    const bars = await win.evaluate(() => document.querySelectorAll('.sidebar-foot .lim').length);
    if (bars < 2) throw new Error(`${bars} bars in the sidebar`);
    return `5h ${l.fiveHour.usedPct}% · 7d ${l.sevenDay.usedPct}%`;
  });

  await soft('a queued message can be edited and another removed before Claude gets them', async () => {
    const t0 = await turns();
    await send('Run the Bash command `sleep 12 && echo slept` and then reply with just LONG-DONE.');
    await win.waitForSelector(`${V} .rv-work .rv-dot.running, ${V} .rv-tool.running`, { timeout: 60_000 });
    await send(`Reply with just KEEP-${tag}-WRONG.`);
    await send(`Reply with just DROP-${tag}.`);
    await waitFor(async () => (await items()).length === 2, 'two held messages', 8000);
    const btns = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-queue-item`)[0].querySelectorAll('.chip-btn')].map((b) => b.textContent.trim()), V);
    if (!btns.some((b) => /Send now/.test(b)) || !btns.includes('Edit') || !btns.includes('✕')) throw new Error(`buttons: ${btns}`);
    // Edit the first.
    await win.click(`${V} .rv-queue-item >> nth=0 >> button:has-text("Edit")`);
    await win.fill(`${V} .rv-queue-edit`, `Reply with just KEEP-${tag}-RIGHT.`);
    await win.press(`${V} .rv-queue-edit`, 'Enter');
    await waitFor(async () => (await items())[0]?.includes('RIGHT'), 'the edited text', 8000);
    // Remove the second.
    await win.click(`${V} .rv-queue-item >> nth=1 >> button:has-text("✕")`);
    await waitFor(async () => (await items()).length === 1, 'one left', 8000);
    await win.screenshot({ path: join(ART, 'queue-1-held.png') });
    await waitFor(async () => (await turns()) >= t0 + 2, 'the queued turn', 120_000);
    await waitFor(async () => (await text()).includes(`KEEP-${tag}-RIGHT`) || true, 'x', 1000);
    await sleep(1500);
    const t = await text();
    if (/DROP-/.test(t.replace(`DROP-${tag}.`, '')) && t.split(`DROP-${tag}`).length > 2) throw new Error('the removed message was answered');
    if (t.includes(`KEEP-${tag}-WRONG`) && !t.includes(`KEEP-${tag}-RIGHT`)) throw new Error('the unedited text was sent');
    const sentBubble = await win.evaluate(({ v, w }) => [...document.querySelectorAll(`${v} .rv-scroll .rv-user`)].map((e) => e.textContent).filter((x) => x.includes(w)).length, { v: V, w: `DROP-${tag}` });
    if (sentBubble) throw new Error('the removed message reached the conversation');
    if (!t.includes(`KEEP-${tag}-RIGHT`)) throw new Error('the edited message was not sent');
    return 'edited sent, removed never sent';
  });

  await soft('Send now stops the turn and Claude takes that message straight away', async () => {
    await idle();
    const t0 = await turns();
    const started = Date.now();
    await send('Run this exact Bash command: python3 -c "import time; time.sleep(40)" and then reply with just SLOW-DONE.');
    await win.waitForSelector(`${V} .rv-work .rv-dot.running, ${V} .rv-tool.running`, { timeout: 60_000 });
    await send(`Reply with just NOW-${tag}.`);
    await waitFor(async () => (await items()).length === 1, 'a held message', 8000);
    await win.click(`${V} .rv-queue-item >> button:has-text("Send now")`);
    await waitFor(async () => (await text()).split(`NOW-${tag}`).length > 2, 'the answer', 60_000);
    const took = Date.now() - started;
    if (took > 50_000) throw new Error(`it waited for the slow command (${took} ms)`);
    if ((await text()).split('SLOW-DONE').length > 2) throw new Error('the slow command ran to the end');
    return `${Math.round(took / 1000)}s`;
  });

  await soft('stopping Claude holds what is queued until you send it', async () => {
    await idle();
    await send('Run this exact Bash command: python3 -c "import time; time.sleep(30)" and then reply with just HELD-TEST.');
    await win.waitForSelector(`${V} .rv-work .rv-dot.running, ${V} .rv-tool.running`, { timeout: 60_000 });
    await send(`Reply with just AFTER-${tag}.`);
    await waitFor(async () => (await items()).length === 1, 'a held message', 8000);
    await win.focus(`${V} .rv-input`);
    await win.press(`${V} .rv-input`, 'Escape');
    await waitFor(async () => /Stopped/.test((await win.textContent(`${V} .rv-queue-title`).catch(() => '')) ?? ''), 'the stopped state', 30_000);
    await idle();
    await sleep(5000);
    if ((await text()).split(`AFTER-${tag}`).length > 2) throw new Error('it was sent although you stopped Claude');
    if ((await items()).length !== 1) throw new Error('the held message is gone');
    await win.screenshot({ path: join(ART, 'queue-2-stopped.png') });
    await win.click(`${V} .rv-queue-item >> button:has-text("Send now")`);
    await waitFor(async () => (await text()).split(`AFTER-${tag}`).length > 2, 'the answer', 60_000);
    return 'held, then sent on request';
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
