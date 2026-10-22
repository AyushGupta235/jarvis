#!/usr/bin/env node
/**
 * Every Claude Code slash command in the rich view: the palette lists them all, the native ones (/plan, /btw,
 * /add-dir, /cd, /branch, /fork, /tasks, /mcp, /hooks, /agents, /skills, /rename, /color, /theme, /focus...) do their
 * job, pages and notes answer, SDK commands run, and screen-only ones reopen in a terminal. Isolated; a few Haiku calls.
 *
 *   node e2e/rich-slash.e2e.mjs [--keep]
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = require('playwright');
const KEEP = process.argv.includes('--keep');

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-slash-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-slash-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const env = {
  ...process.env,
  JARVIS_HOME: join(tmp, 'home'), JARVIS_TMUX_SOCKET: SOCKET, JARVIS_REPO_ROOTS: join(tmp, 'repos'),
  JARVIS_USER_DATA: join(tmp, 'electron'), JARVIS_NO_EXTERNAL: '1', JARVIS_NO_PRS: '1', JARVIS_NO_USAGE: '1', JARVIS_CLAUDE_HOME: join(homedir(), '.claude'), JARVIS_ASSUME_YES: '1',
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
  if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) return;
  try {
    const d = await fn();
    check(name, true, typeof d === 'string' ? d : '');
  } catch (e) {
    check(name, false, e.message.split('\n')[0].slice(0, 220));
    await win.screenshot({ path: join(ART, `slash-fail-${results.length}.png`) }).catch(() => {});
    await win.screenshot({ path: join(ART, `agents-fail-${results.length}.png`) }).catch(() => {});
  }
};

let app;
let win;
let daemonPid = null;
const V = '.rich-wrap:not([style*="none"])';
const rpc = (m, p) => win.evaluate(([m, p]) => window.jarvis.rpc(m, p), [m, p]);
const table = readFileSync(join(ROOT, 'apps/desktop/src/renderer/src/commandTable.ts'), 'utf8');
const expectedNames = [...new Set([...table.matchAll(/\{ name: '([a-z-]+)'/g)].map((m) => m[1]).concat([...table.matchAll(/aliases: \[([^\]]+)\]/g)].flatMap((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]))))];
try {
  app = await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1400, height: 900 }));
  await waitFor(() => win.$('.daemon-dot.ok'), 'daemon', 20_000);
  daemonPid = (await rpc('snapshot')).daemon.pid;
  const sess = async (id) => (await rpc('snapshot')).sessions.find((x) => x.id === id);
  const turns = () => win.evaluate((v) => document.querySelectorAll(`${v} .rv-turn`).length, V);
  const text = () => win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText, V);
  const send = async (t) => {
    await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30_000 });
    await win.fill(`${V} .rv-input`, t);
    await win.press(`${V} .rv-input`, 'Enter');
  };
  const turn = async (t, timeout = 120_000) => { const t0 = await turns(); await send(t); await waitFor(async () => (await turns()) > t0, 'the turn', timeout); };
  const toast = () => win.evaluate((v) => document.querySelector(`${v} .rv-toast`)?.textContent ?? '', V);
  const pickerTitle = () => win.evaluate((v) => document.querySelector(`${v} .rv-picker-title, ${v} .rv-pick-title`)?.textContent ?? '', V);
  const pickLabels = () => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-pick`)].map((e) => e.textContent), V);
  const closePicker = async () => { await win.keyboard.press('Escape'); await sleep(200); };

  const s = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto', name: 'slash' });
  await win.click(`[data-id="${s.id}"]`);
  await turn(`Remember the number 7311 and reply with just OK.`);

  await soft('the palette lists every Claude Code command, aliases included', async () => {
    await win.fill(`${V} .rv-input`, '/');
    await waitFor(async () => (await win.$$(`${V} .rv-cmd`)).length > 60, 'the palette', 20_000);
    const names = new Set(await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-cmd-name`)].map((e) => e.textContent.replace(/^\//, '')), V));
    const missing = expectedNames.filter((n) => !names.has(n));
    if (missing.length) throw new Error(`missing from the palette: ${missing.join(', ')}`);
    await win.fill(`${V} .rv-input`, '');
    return `${names.size} commands, all ${expectedNames.length} built-ins and aliases present`;
  });

  await soft('/plan switches to plan mode', async () => {
    await send('/plan');
    await waitFor(async () => (await rpc('rich.info', { id: s.id })).permissionMode === 'plan', 'plan mode', 15_000);
    await rpc('rich.setPermissionMode', { id: s.id, mode: 'auto' });
    return (await toast()).slice(0, 60);
  });

  await soft('/btw answers from the conversation without adding to it', async () => {
    const before = await win.evaluate((v) => document.querySelectorAll(`${v} .rv-scroll .rv-user`).length, V);
    await send('/btw what number did I ask you to remember? Just the number.');
    await win.waitForSelector(`${V} .rv-btw`, { timeout: 10_000 });
    await waitFor(async () => /7311/.test(await win.textContent(`${V} .rv-btw`)), 'the answer', 90_000);
    const after = await win.evaluate((v) => document.querySelectorAll(`${v} .rv-scroll .rv-user`).length, V);
    if (after !== before) throw new Error('the side question became a message in the conversation');
    const pts = await rpc('rich.rewindPoints', { id: s.id });
    if (pts.some((p) => /what number did I ask/.test(p.text))) throw new Error('the side question is in the transcript');
    await win.screenshot({ path: join(ART, 'slash-1-btw.png') });
    return 'answered, nothing added';
  });

  await soft('/rename pins a name and /rename alone gives it back to Claude', async () => {
    await send('/rename Slash test');
    await waitFor(async () => (await sess(s.id)).name === 'Slash test' && (await sess(s.id)).nameLocked, 'pinned name', 10_000);
    await send('/rename');
    await waitFor(async () => !(await sess(s.id)).nameLocked, 'unlocked', 10_000);
    return 'ok';
  });

  await soft('/color, /focus and /theme change the view', async () => {
    await send('/color red');
    await waitFor(async () => (await win.getAttribute(V, 'data-accent')) === 'red', 'accent', 5000);
    await send('/color default');
    const d0 = await win.evaluate(() => document.querySelector('.rv-density .seg-btn.on')?.textContent);
    await send('/focus');
    await waitFor(async () => (await win.evaluate(() => document.querySelector('.rv-density .seg-btn.on')?.textContent)) === 'Focus', 'focus density', 5000);
    await send('/focus');
    await waitFor(async () => (await win.evaluate(() => document.querySelector('.rv-density .seg-btn.on')?.textContent)) === 'Normal', 'normal density', 5000);
    await send('/theme');
    await win.waitForSelector(`${V} .rv-pick`, { timeout: 5000 });
    const n = (await pickLabels()).length;
    if (n < 15) throw new Error(`${n} themes`);
    await win.locator(`${V} .rv-pick`).filter({ hasText: 'Tokyo Night' }).first().click();
    await waitFor(async () => (await win.evaluate(() => document.documentElement.dataset.theme)) === 'tokyo-night', 'theme', 5000);
    await send('/theme');
    await win.waitForSelector(`${V} .rv-pick`, { timeout: 5000 });
    await win.locator(`${V} .rv-pick`).filter({ hasText: 'Graphite' }).first().click();
    return `${d0} density, ${n} themes`;
  });

  await soft('/hooks, /agents, /skills and /mcp open their lists', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo slash-hook-test' }] }] } }));
    await send('/hooks');
    await waitFor(async () => (await pickLabels()).some((l) => /PreToolUse/.test(l) && /slash-hook-test/.test(l)), 'the hook', 10_000);
    await closePicker();
    await send('/agents');
    await waitFor(async () => (await pickLabels()).length > 2, 'agents', 15_000);
    await closePicker();
    await send('/skills');
    await waitFor(async () => (await pickLabels()).length > 10, 'skills', 10_000);
    await closePicker();
    await send('/mcp');
    await waitFor(async () => (await win.$$(`${V} .rv-pick`)).length > 0 && /MCP servers: \d+ connected/.test(await win.evaluate((v) => document.querySelector(`${v} .rv-picker`)?.textContent ?? '', V)), 'MCP list', 60_000);
    await win.screenshot({ path: join(ART, 'slash-2-mcp.png') });
    const n = (await pickLabels()).length;
    await closePicker();
    return `${n} MCP servers`;
  });

  await soft('/tasks lists background work and stops it', async () => {
    // Its own session: an unfinished background task replays into anything forked from this conversation.
    const tk = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto', name: 'tasks' });
    await win.click(`[data-id="${tk.id}"]`);
    await turn('Run this exact Bash command in the background (run_in_background true): python3 -c "import time; time.sleep(90)". Then reply with just STARTED.', 120_000);
    await waitFor(async () => { await send('/tasks'); await sleep(800); const l = await pickLabels(); await closePicker(); return l.some((x) => /running/.test(x)); }, 'a running task', 40_000, 1500);
    await send('/tasks');
    await win.locator(`${V} .rv-pick`).filter({ hasText: 'running' }).first().click();
    await sleep(1500);
    await waitFor(async () => { await send('/tasks'); await sleep(800); const l = await pickLabels(); await closePicker(); return !l.some((x) => /running/.test(x)); }, 'the task stopped', 40_000, 1500);
    await win.click(`[data-id="${s.id}"]`);
    await rpc('sessions.remove', { id: tk.id });
    return 'listed and stopped';
  });

  await soft('/hooks-style notes and pages: /vim, /release-notes', async () => {
    await send('/vim');
    await waitFor(async () => /removed/.test(await toast()), 'the note', 5000);
    await send('/release-notes');
    await waitFor(async () => /code\.claude\.com/.test(await toast()), 'the page', 5000);
    return 'ok';
  });

  await soft('SDK commands still run: /advisor and /usage', async () => {
    await send('/advisor');
    await waitFor(async () => /Advisor:/.test(await text()), 'advisor output', 30_000);
    await send('/usage');
    await waitFor(async () => /subscription|usage/i.test((await text()).split('Advisor:').pop()), 'usage output', 30_000);
    // In history, a command Claude Code ran reads as what you typed and what it printed, not as its tags.
    await rpc('rich.restart', { id: s.id });
    await waitFor(async () => /resumed/.test(await text()), 'history after a restart', 60_000);
    const t = await text();
    if (/<command-(name|message|args)>|<local-command/.test(t)) throw new Error('command tags are on screen after a restart');
    if (!/\/advisor/.test(t)) throw new Error('the /advisor you typed is missing from the history');
    return 'ok';
  });

  await soft('/add-dir lets Claude read another directory without asking', async () => {
    const extra = join(tmp, 'extra');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'hello.txt'), `HELLO-${tag}`);
    const d = await rpc('sessions.create', { cwd: repo, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'default', name: 'adddir' });
    await win.click(`[data-id="${d.id}"]`);
    await send(`Use the Read tool on ${extra}/hello.txt and reply with its contents.`);
    await win.waitForSelector(`${V} .rv-perm`, { timeout: 90_000 });
    await win.click(`${V} .rv-perm .btn:has-text("Deny")`);
    await waitFor(async () => (await sess(d.id)).agentState?.phase !== 'working', 'idle', 90_000);
    await send(`/add-dir ${extra}`);
    await waitFor(async () => /Claude can now work in/.test(await toast()), 'added', 10_000);
    const t0 = await turns();
    await send(`Use the Read tool on ${extra}/hello.txt and reply with its contents.`);
    await waitFor(async () => (await turns()) > t0, 'the turn', 90_000).catch(() => {});
    const asked = await win.$(`${V} .rv-perm:not(.done)`);
    await waitFor(async () => (await text()).split(`HELLO-${tag}`).length > 1, 'the file contents', 60_000);
    if (asked) throw new Error('Claude still asked for permission after /add-dir');
    await win.click(`[data-id="${s.id}"]`);
    await rpc('sessions.remove', { id: d.id });
    return 'asked before, not after';
  });

  await soft('/fork copies the conversation into a new session, /branch continues in a fork', async () => {
    await send('/fork what number did I ask you to remember? Reply with just the number.');
    const f = await waitFor(async () => (await rpc('snapshot')).sessions.find((x) => /\(fork\)$/.test(x.name)), 'the forked session', 60_000);
    if (f.agentSessionId === (await sess(s.id)).agentSessionId) throw new Error('same conversation id');
    await rpc('sessions.remove', { id: f.id });
    const before = (await sess(s.id)).agentSessionId;
    await send('/branch');
    await waitFor(async () => (await sess(s.id)).agentSessionId !== before && (await sess(s.id)).rich?.connected, 'the branch', 60_000);
    await turn('What number did I ask you to remember? Reply with just the number.');
    if (!/7311/.test((await text()).split('What number did I ask you to remember? Reply with just the number.').pop())) throw new Error('the branch lost the conversation');
    return 'fork and branch keep the conversation';
  });

  await soft('/rewind puts the prompt you went back to into the composer', async () => {
    // (after /branch the conversation has a second prompt to go back to)
    await send('/rewind');
    await waitFor(async () => (await win.$$(`${V} .rv-pick:not(.muted)`)).length >= 1, 'rewind points', 20_000);
    const points = await rpc('rich.rewindPoints', { id: s.id });
    const want = points.find((p) => /^What number did I ask you to remember/.test(p.text) && p.before)?.text;
    if (!want) throw new Error('no rewind point for the later prompt');
    const before = (await sess(s.id)).agentSessionId;
    await win.locator(`${V} .rv-pick`).filter({ hasText: 'What number did I ask you to remember' }).first().click();
    await waitFor(async () => (await sess(s.id)).agentSessionId !== before && (await sess(s.id)).rich?.connected, 'the fork', 60_000);
    await waitFor(async () => (await win.inputValue(`${V} .rv-input`)) !== '', 'the composer to fill', 10_000).catch(() => {});
    const box = await win.inputValue(`${V} .rv-input`);
    if (box !== want) throw new Error(`the composer holds ${JSON.stringify(box.slice(0, 50))} instead of ${JSON.stringify(want.slice(0, 50))}`);
    await win.fill(`${V} .rv-input`, '');
    return 'the prompt is back in the box';
  });

  await soft('/cd moves the session to another directory with the conversation', async () => {
    const other = join(tmp, 'repos', 'other');
    mkdirSync(other, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other });
    await send(`/cd ${other}`);
    await waitFor(async () => (await sess(s.id)).cwd.endsWith('/repos/other') && (await sess(s.id)).rich?.connected, 'the move', 60_000);
    await turn('What number did I ask you to remember? Reply with just the number.');
    if (!/7311/.test((await text()).split('What number did I ask you to remember? Reply with just the number.').pop())) throw new Error('the conversation did not come along');
    return 'moved, conversation intact';
  });

  await soft('/rewind to the very first prompt starts a fresh conversation with that prompt in the composer', async () => {
    const before = (await sess(s.id)).agentSessionId;
    await send('/rewind');
    await waitFor(async () => (await win.$$(`${V} .rv-pick:not(.muted)`)).length >= 1, 'rewind points', 20_000);
    const points = await rpc('rich.rewindPoints', { id: s.id });
    const first = points.find((p) => /^Remember the number 7311/.test(p.text))?.text;
    if (!first) throw new Error('the first prompt is not offered');
    await win.locator(`${V} .rv-pick`).filter({ hasText: 'Remember the number 7311' }).first().click();
    await waitFor(async () => (await sess(s.id)).agentSessionId !== before, 'a new conversation', 60_000);
    await waitFor(async () => (await win.inputValue(`${V} .rv-input`)) === first, 'the prompt in the composer', 15_000);
    return 'fresh conversation, prompt restored';
  });

  await soft('a screen-only command (/powerup) still reopens in a terminal', async () => {
    await send('/powerup');
    const x = await waitFor(async () => { const y = await sess(s.id); return y.mode === 'terminal' ? y : null; }, 'terminal mode', 30_000);
    return x.tmuxName;
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
