#!/usr/bin/env node
/**
 * Queued messages while sub-agents work: a queued message reaches Claude at its next step (not at the end of a long
 * turn), "Send now" hands it over without stopping the sub-agents, and nothing lingers in the queue tray once Claude
 * has it. Isolated; a few Haiku calls.
 *
 *   node e2e/rich-queue-agents.e2e.mjs [--keep]
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

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-qagents-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-qagents-${process.pid}`;
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
    await win.screenshot({ path: join(ART, `qagents-fail-${results.length}.png`) }).catch(() => {});
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

  const s = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto', name: 'qa' });
  await win.click(`[data-id="${s.id}"]`);
  await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30000 });

  await soft('Send now while a sub-agent runs does not stop it, and Claude answers once the agent is done', async () => {
    await send('Use the Agent tool (general-purpose, description "slow job") to run `python3 -c "import time; time.sleep(30)"` with Bash and then report SLOW-JOB-DONE. Wait for it and reply with its report.');
    await waitFor(async () => (await cards()).some((c) => /slow job/.test(c.head) && /running/.test(c.cls)), 'the running agent', 90_000);
    await send(`Reply with just NOW-${tag}.`);
    await waitFor(async () => (await tray()).length === 1, 'a queued message', 8000);
    await win.click(`${V} .rv-queue-item >> button:has-text("Send now")`);
    await sleep(8000);
    const mid = (await cards()).find((c) => /slow job/.test(c.head));
    if (!/running/.test(mid.cls)) throw new Error(`Send now stopped the agent: ${mid.cls}`);
    await idle(s.id);
    const card = (await cards()).find((c) => /slow job/.test(c.head));
    if (/stopped|failed/.test(card.cls)) throw new Error(`the agent ended as ${card.cls}`);
    if (!(await text()).includes(`NOW-${tag}`)) throw new Error('Claude never answered the message');
    return `agent ${card.cls.replace(/rv-agent\s*/, '')}`;
  });

  await soft('nothing lingers in the queue tray once Claude has the messages', async () => {
    await sleep(1000);
    const t = await tray();
    if (t.length) throw new Error(`still in the tray: ${JSON.stringify(t)}`);
    return 'tray empty';
  });

  await soft('a queued message reaches Claude at its next step, not at the end of a long turn', async () => {
    const before = (await events(s.id)).length;
    await send('Run these three Bash commands one after another, each as its own separate call: `sleep 8`, `sleep 8`, `sleep 8`. Then reply with just STEPS-DONE.');
    await win.waitForSelector(`${V} .rv-work .rv-dot.running, ${V} .rv-tool.running`, { timeout: 60_000 });
    await send(`When you are done, also say MID-${tag}.`);
    await waitFor(async () => (await events(s.id)).slice(before).some((e) => e.kind === 'queue' && e.action === 'release'), 'the release', 20_000);
    const ev = (await events(s.id)).slice(before);
    const rel = ev.findIndex((e) => e.kind === 'queue' && e.action === 'release');
    const end = ev.findIndex((e) => e.kind === 'turn_end');
    if (end !== -1 && end < rel) throw new Error('it was only released after the turn ended');
    if (!ev[rel].midTurn) throw new Error('released as a new turn, not folded in');
    await idle(s.id);
    if (!(await text()).includes(`MID-${tag}`)) throw new Error('the message was not acted on');
    return 'folded in mid-turn';
  });

  await soft('a queued slash command leaves the tray instead of sitting there as "with Claude"', async () => {
    await send('Run the Bash command `sleep 10` and then reply with just CMD-DONE.');
    await win.waitForSelector(`${V} .rv-work .rv-dot.running, ${V} .rv-tool.running`, { timeout: 60_000 });
    await send('/effort high');
    await send('/model haiku');
    await idle(s.id);
    await sleep(1500);
    const t = await tray();
    if (t.length) throw new Error(`still in the tray: ${JSON.stringify(t)}`);
    if (await win.locator(`${V} .rv-queue`).count()) throw new Error('an empty queue tray is still showing');
    return 'tray gone';
  });

  await soft('stopping the turn still holds the queue until you decide', async () => {
    await send('Run this exact Bash command: python3 -c "import time; time.sleep(30)" and then reply with just HELD-TEST.');
    await win.waitForSelector(`${V} .rv-work .rv-dot.running, ${V} .rv-tool.running`, { timeout: 60_000 });
    await win.focus(`${V} .rv-input`);
    await send(`Reply with just AFTER-${tag}.`);
    await win.focus(`${V} .rv-input`);
    await win.press(`${V} .rv-input`, 'Escape');
    await idle(s.id);
    await sleep(4000);
    if ((await text()).split(`AFTER-${tag}`).length > 2) throw new Error('sent although you stopped Claude');
    return (await tray()).join(' | ').slice(0, 80);
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
