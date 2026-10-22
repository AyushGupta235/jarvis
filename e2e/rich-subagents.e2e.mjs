#!/usr/bin/env node
/**
 * Sub-agents in the rich view: parallel agents as cards with a live clock and a Stop button, the sub-agent count,
 * history after a restart (every card back, with stats and its steps from the agent's own transcript), who a
 * permission request came from, and the Run agent dialog. Isolated; several Haiku calls.
 *
 *   node e2e/rich-subagents.e2e.mjs [--keep]
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

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-subagents-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-subagents-${process.pid}`;
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
for (let i = 0; i < 4; i++) writeFileSync(join(repo, 'docs', `page${i}.md`), `page ${i}\n`.repeat(20));
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1400, height: 1000 }));
  await waitFor(() => win.$('.daemon-dot.ok'), 'daemon', 20_000);
  daemonPid = (await rpc('snapshot')).daemon.pid;
  const sess = async (id) => (await rpc('snapshot')).sessions.find((x) => x.id === id);
  const text = () => win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText, V);
  const idle = async (id) => waitFor(async () => (await sess(id)).agentState?.phase !== 'working', 'idle', 180_000);
  const cards = () => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-scroll > .rv-column > .rv-agent, ${v} .rv-column > .rv-agent`)].map((c) => ({ head: c.querySelector('.rv-agent-head').innerText.replace(/\s+/g, ' '), cls: c.className, stop: !!c.querySelector('.rv-agent-stop') })), V);

  const s = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto', name: 'agents' });
  await win.click(`[data-id="${s.id}"]`);
  await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30000 });
  await win.fill(`${V} .rv-input`, 'In ONE message, launch three subagents in parallel with the Agent tool: (1) subagent_type Explore, description "map docs", list the files under docs/ and report their names; (2) general-purpose, description "slow count", run `python3 -c "import time; time.sleep(40)"` with Bash, then run wc -l docs/page0.md and report it; (3) general-purpose, description "will fail", try to read /nonexistent/file.txt with the Read tool and report exactly the error. Wait for all three and reply with a one-line summary.');
  await win.press(`${V} .rv-input`, 'Enter');

  let maxRunning = 0;
  await soft('three parallel agents are three cards, the count says so, and a running one has a clock and a Stop button', async () => {
    await waitFor(async () => (await cards()).length === 3, 'three cards', 90_000);
    const end = Date.now() + 25_000;
    while (Date.now() < end) { maxRunning = Math.max(maxRunning, (await sess(s.id)).agentState?.subagentsRunning ?? 0); await sleep(500); }
    const slow = (await cards()).find((c) => /slow count/.test(c.head));
    if (!slow || !/running/.test(slow.cls)) throw new Error(`slow card: ${JSON.stringify(slow)}`);
    if (!slow.stop) throw new Error('no Stop button on the running agent');
    const t1 = (slow.head.match(/(\d+)s/g) ?? []).pop();
    await sleep(3000);
    const t2 = ((await cards()).find((c) => /slow count/.test(c.head)).head.match(/(\d+)s/g) ?? []).pop();
    if (!t1 || !t2 || parseInt(t2) <= parseInt(t1)) throw new Error(`the clock did not move: ${t1} -> ${t2}`);
    if (maxRunning < 3) throw new Error(`the sub-agent count peaked at ${maxRunning}`);
    await win.screenshot({ path: join(ART, 'subagents-1-live.png') });
    return `clock ${t1} -> ${t2}, count peaked at ${maxRunning}`;
  });

  await soft('Stop on a card stops that agent and the turn carries on', async () => {
    await win.locator(`${V} .rv-agent:has-text("slow count") .rv-agent-stop`).click();
    await waitFor(async () => { const c = (await cards()).find((x) => /slow count/.test(x.head)); return c && !/running/.test(c.cls); }, 'the card to stop running', 30_000);
    await idle(s.id);
    const cls = (await cards()).find((x) => /slow count/.test(x.head)).cls;
    if (!/stopped/.test(cls)) throw new Error(`a stopped agent reads as: ${cls}`);
    return cls;
  });

  await soft('open cards list their steps and the tool-call count matches them', async () => {
    for (const h of await win.$$(`${V} .rv-agent-head`)) await h.click();
    await sleep(500);
    const info = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-column > .rv-agent`)].map((c) => ({
      n: (c.querySelector('.rv-agent-stats')?.innerText.match(/(\d+) tool call/) ?? [])[1], steps: c.querySelectorAll('.rv-agent-steps > .rv-tool').length,
      stopped: /stopped/.test(c.className + c.querySelector('.rv-agent-head').innerText) })), V);
    for (const c of info) if (!c.stopped && c.n && Number(c.n) !== c.steps) throw new Error(`header says ${c.n} but ${c.steps} steps are listed: ${JSON.stringify(info)}`);
    return JSON.stringify(info);
  });

  await soft('after a restart every agent card is back, finished, with its stats and its steps from the agent transcript', async () => {
    await rpc('rich.restart', { id: s.id });
    await waitFor(async () => /resumed/.test(await text()), 'history', 60_000);
    await sleep(1500);
    const c = await cards();
    if (c.length !== 3) throw new Error(`${c.length} cards after restart: ${JSON.stringify(c)}`);
    const running = c.filter((x) => /running/.test(x.cls));
    if (running.length) throw new Error(`${running.length} card(s) stuck on running: ${JSON.stringify(c)}`);
    const noStats = c.filter((x) => !/tool call/.test(x.head) && !/stopped/.test(x.cls + x.head));
    if (noStats.length) throw new Error(`no stats on: ${JSON.stringify(noStats)}`);
    await win.locator(`${V} .rv-column > .rv-agent`).filter({ hasText: 'map docs' }).locator('.rv-agent-head').click();
    await waitFor(async () => (await win.$$(`${V} .rv-agent:has-text("map docs") .rv-agent-steps > .rv-tool`)).length >= 1, 'the steps from the transcript', 20_000);
    await win.screenshot({ path: join(ART, 'subagents-2-history.png') });
    return JSON.stringify(c.map((x) => x.head.slice(0, 50)));
  });

  await soft('Run agent: choose a kind, give it a task, and it runs as that kind', async () => {
    await win.click(`${V} .rv-composer-bar button:has-text("Agent")`);
    await win.waitForSelector(`${V} .rv-runagent`, { timeout: 15_000 });
    const options = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-runagent select option`)].map((o) => o.textContent), V);
    if (!options.some((o) => /Explore/.test(o))) throw new Error(`agent kinds: ${options}`);
    await win.selectOption(`${V} .rv-runagent select`, { label: options.find((o) => /Explore/.test(o)) });
    await win.fill(`${V} .rv-runagent-prompt`, 'List the file names in the docs/ directory of the current repository and report them, nothing else.');
    await win.screenshot({ path: join(ART, 'subagents-3-run-dialog.png') });
    const before = (await cards()).length;
    await win.click(`${V} .rv-runagent .btn.primary`);
    await waitFor(async () => (await cards()).length === before + 1, 'the new card', 90_000);
    await idle(s.id);
    const card = (await cards()).at(-1);
    if (!/Explore/.test(card.head)) throw new Error(`the new card is ${card.head}`);
    await win.locator(`${V} .rv-column > .rv-agent`).last().locator('.rv-agent-head').click();
    await waitFor(async () => /guide\.md/.test(await win.locator(`${V} .rv-column > .rv-agent`).last().innerText()), 'its result', 30_000);
    return card.head.slice(0, 60);
  });

  await soft('a permission request from a sub-agent says which one asked', async () => {
    const extra = join(tmp, 'extra');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'hello.txt'), `HELLO-${tag}`);
    const d = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'default', name: 'perm' });
    await win.click(`[data-id="${d.id}"]`);
    await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30000 });
    await win.fill(`${V} .rv-input`, `Use the Agent tool (general-purpose, description "read hello") to read ${extra}/hello.txt with the Read tool and report its contents.`);
    await win.press(`${V} .rv-input`, 'Enter');
    await win.waitForSelector(`${V} .rv-perm`, { timeout: 120_000 });
    const t = await win.textContent(`${V} .rv-perm`);
    await win.click(`${V} .rv-perm .btn:has-text("Deny")`);
    if (!/asked by sub-agent/.test(t)) throw new Error(`permission card: ${t}`);
    await win.screenshot({ path: join(ART, 'subagents-4-permission.png') });
    return t.replace(/\s+/g, ' ').slice(0, 100);
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
