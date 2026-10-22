#!/usr/bin/env node
/**
 * Session names and worktrees, sub-agents, background-task reports, compaction and long messages in the rich
 * view. Isolated; a handful of Haiku calls.
 *
 *   node e2e/rich-agents.e2e.mjs [--keep]
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

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-agents-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-agents-${process.pid}`;
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
  const sess = async (id) => (await rpc('snapshot')).sessions.find((x) => x.id === id);
  const turns = () => win.evaluate((v) => document.querySelectorAll(`${v} .rv-turn`).length, V);
  const send = async (text) => {
    await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30_000 });
    await win.fill(`${V} .rv-input`, text);
    await win.press(`${V} .rv-input`, 'Enter');
  };
  const turn = async (text, timeout = 120_000) => {
    const t0 = await turns();
    await send(text);
    await waitFor(async () => (await turns()) > t0, 'the turn to finish', timeout);
  };

  const s = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto' });
  await win.click(`[data-id="${s.id}"]`);

  // ---- names ----
  await soft('a new session starts with the repo name and follows Claude\'s title', async () => {
    if ((await sess(s.id)).name !== 'atlas' || (await sess(s.id)).nameLocked) throw new Error(`started as ${(await sess(s.id)).name}`);
    await turn('Reply with just OK.');
    const path = readdirSync(join(homedir(), '.claude/projects')).map((d) => join(homedir(), '.claude/projects', d, `${s.agentSessionId}.jsonl`)).find((p) => existsSync(p));
    if (!path) throw new Error('no transcript');
    appendFileSync(path, `{"type":"ai-title","aiTitle":"Probe the atlas pods","sessionId":"${s.agentSessionId}"}\n`);
    await waitFor(async () => (await sess(s.id)).name === 'Probe the atlas pods', 'the title', 20_000);
    const shown = await win.evaluate((id) => document.querySelector(`[data-id="${id}"] .name`)?.textContent, s.id);
    if (shown !== 'Probe the atlas pods') throw new Error(`sidebar shows ${shown}`);
    appendFileSync(path, `{"type":"ai-title","aiTitle":"Second title","sessionId":"${s.agentSessionId}"}\n`);
    await waitFor(async () => (await sess(s.id)).name === 'Second title', 'the new title', 20_000);
    // Naming it yourself pins the name; an empty name hands it back.
    await rpc('sessions.rename', { id: s.id, name: 'My own name' });
    appendFileSync(path, `{"type":"ai-title","aiTitle":"Third title","sessionId":"${s.agentSessionId}"}\n`);
    await sleep(6000);
    const pinned = await sess(s.id);
    if (pinned.name !== 'My own name' || !pinned.nameLocked) throw new Error(`pinned name is ${pinned.name}`);
    await rpc('sessions.rename', { id: s.id, name: '' });
    await waitFor(async () => (await sess(s.id)).name === 'Third title', 'following again', 20_000);
    return 'follows, pins on rename, follows again when emptied';
  });

  // ---- worktrees ----
  await soft('a second session in the same checkout is offered a new worktree, with its own branch', async () => {
    if ((await sess(s.id)).sharesCheckout) throw new Error('a lone session claims to share its checkout');
    await win.click('button[title^="New session"]');
    await win.waitForSelector('.modal .shared-note', { timeout: 8000 });
    const note = await win.textContent('.modal .shared-note');
    if (!/already here/.test(note)) throw new Error(`note: ${note}`);
    const on = await win.evaluate(() => document.querySelector('.modal .shared-note .seg-btn.on')?.textContent);
    if (on !== 'New worktree') throw new Error(`default choice is ${on}`);
    await win.screenshot({ path: join(ART, 'agents-1-worktree-offer.png') });
    await win.click('.modal .btn.primary');
    const n = await waitFor(async () => (await rpc('snapshot')).sessions.find((x) => x.id !== s.id && !x.external), 'the second session', 30_000);
    if (!n.worktree || !n.worktree.includes('/worktrees/atlas/')) throw new Error(`worktree: ${n.worktree}`);
    if (!/^jarvis\//.test(n.branch ?? '')) throw new Error(`branch: ${n.branch}`);
    if (n.sharesCheckout || (await sess(s.id)).sharesCheckout) throw new Error('still reported as sharing');
    const main = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();
    if (main !== 'main') throw new Error(`the original checkout moved to ${main}`);
    await win.click(`[data-id="${s.id}"]`);
    return `${n.branch} in ${n.worktree.split('/').slice(-2).join('/')}`;
  });

  await soft('choosing the same checkout shares it, and both sessions say so', async () => {
    await win.click('button[title^="New session"]');
    await win.waitForSelector('.modal .shared-note', { timeout: 8000 });
    await win.click('.modal .shared-note .seg-btn:has-text("Same checkout")');
    await win.click('.modal .btn.primary');
    const n = await waitFor(async () => (await rpc('snapshot')).sessions.find((x) => x.id !== s.id && !x.worktree && !x.external), 'the shared session', 30_000);
    await waitFor(async () => (await sess(s.id)).sharesCheckout && (await sess(n.id)).sharesCheckout, 'the shared marker', 10_000)
      .catch(async (e) => { throw new Error(`${e.message} ${JSON.stringify((await rpc('snapshot')).sessions.map((x) => ({ id: x.id, wt: x.worktree, cwd: x.cwd, st: x.status, sh: x.sharesCheckout, mode: x.mode })))}`); });
    const mark = await win.$(`[data-id="${s.id}"] .shared`);
    if (!mark) throw new Error('no marker in the sidebar');
    await rpc('sessions.remove', { id: n.id });
    await win.click(`[data-id="${s.id}"]`);
    return 'marker shown';
  });

  // ---- long messages ----
  await soft('a long message folds, shows its size, and opens in place', async () => {
    const filler = Array.from({ length: 40 }, (_, i) => `filler line ${i + 1} of the pasted log`).join('\n');
    await turn(`Reply with just OK, ignoring this pasted log:\n${filler}`);
    const box = `${V} .rv-scroll .rv-user.folded`;
    await win.waitForSelector(box, { timeout: 5000 });
    const h = await win.evaluate((b) => document.querySelector(b).getBoundingClientRect().height, box);
    if (h > 220) throw new Error(`folded message is ${Math.round(h)}px tall`);
    const label = await win.textContent(`${box} .rv-user-toggle`);
    if (!/40|41/.test(label)) throw new Error(`toggle says ${label}`);
    await win.screenshot({ path: join(ART, 'agents-2-long-message.png') });
    await win.click(`${box} .rv-user-toggle`);
    const full = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-scroll .rv-user`)].find((e) => e.textContent.includes('filler line 40'))?.querySelector('.rv-user-body')?.textContent.includes('filler line 1 of'), V);
    if (!full) throw new Error('the full text is not there after opening');
    return label;
  });

  // ---- sub-agent ----
  await soft('a sub-agent is one card with its stats, steps and result, not steps mixed into the conversation', async () => {
    await turn('Use the Agent tool (general-purpose, description "list atlas docs", in the foreground) to run `ls docs` in the current directory and report the file names. Then reply with just AGENT-DONE.', 180_000);
    const card = `${V} .rv-agent`;
    await win.waitForSelector(card, { timeout: 5000 });
    const head = await win.textContent(`${card} .rv-agent-head`);
    if (!/list atlas docs/.test(head)) throw new Error(`head: ${head}`);
    if (!/tool call/.test(head)) throw new Error(`no stats in the header: ${head}`);
    const stray = await win.evaluate((v) => document.querySelectorAll(`${v} .rv-sub`).length, V);
    if (stray) throw new Error(`${stray} sub-agent rows leaked into the conversation`);
    await win.click(`${card} .rv-agent-head`);
    await win.screenshot({ path: join(ART, 'agents-3-agent-open.png') });
    // A background agent answers later, as a report that arrives as its own turn.
    await waitFor(async () => /guide\.md/.test((await win.textContent(`${card} .rv-agent-result`).catch(() => '')) ?? ''), 'the result in the open card', 120_000);
    await win.screenshot({ path: join(ART, 'agents-3-agent-open.png') });
    const raw = await win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText.includes('Async agent launched'), V);
    if (raw) throw new Error('the launch boilerplate is shown as the result');
    if (!(await win.$(`${card} .rv-agent-steps .rv-tool`))) throw new Error('no steps inside the open card');
    return head.replace(/\s+/g, ' ').slice(0, 90);
  });

  // ---- background task report ----
  await soft('a background command reporting in reads as a notice, not raw tags', async () => {
    await turn('Run `sleep 2 && echo BG-FINISHED` with the Bash tool in the background (run_in_background true), then reply with just STARTED.', 120_000);
    await waitFor(async () => (await win.$(`${V} .rv-notice`)) || (await win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText.includes('BG-FINISHED'), V)), 'the report', 60_000);
    await sleep(1500);
    const raw = await win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText.includes('<task-notification>'), V);
    if (raw) throw new Error('raw <task-notification> tags are on screen');
    return (await win.$(`${V} .rv-notice`)) ? 'notice card' : 'no notice delivered live (Claude read the output itself)';
  });

  // ---- compaction ----
  await soft('/compact shows a marker with what it did and a folded summary, live and after a restart', async () => {
    const t0 = await turns();
    await send('/compact');
    await win.waitForSelector(`${V} .rv-compacting, ${V} .rv-compact`, { timeout: 60_000 });
    await win.waitForSelector(`${V} .rv-compact`, { timeout: 180_000 });
    const text = await win.textContent(`${V} .rv-compact`);
    if (!/Conversation compacted/.test(text)) throw new Error(`marker: ${text}`);
    if (await win.$(`${V} .rv-compacting`)) throw new Error('the compacting row is still up');
    await win.screenshot({ path: join(ART, 'agents-4-compact.png') });
    await waitFor(async () => (await turns()) > t0 || (await win.$(`${V} .rv-compact-summary`)), 'the summary', 30_000);
    const bigUser = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-user`)].some((e) => /This session is being continued/.test(e.textContent)), V);
    if (bigUser) throw new Error('the compaction summary is shown as something you said');
    await rpc('rich.restart', { id: s.id });
    await waitFor(async () => (await win.$(`${V} .rv-compact`)) && (await win.$(`${V} .rv-compact-summary`)), 'history after a restart', 60_000);
    const after = await win.evaluate((v) => {
      const t = document.querySelector(`${v} .rv-scroll`).innerText;
      return { raw: t.includes('<task-notification>'), summaryAsUser: [...document.querySelectorAll(`${v} .rv-user`)].some((e) => /This session is being continued/.test(e.textContent)), agent: !!document.querySelector(`${v} .rv-agent`) };
    }, V);
    if (after.raw || after.summaryAsUser) throw new Error(`after restart: ${JSON.stringify(after)}`);
    if (!after.agent) throw new Error('the sub-agent card is missing from the replayed history');
    return 'marker + folded summary survive a restart';
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
