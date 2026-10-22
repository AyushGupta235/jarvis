#!/usr/bin/env node
/**
 * Rich view extras: messages sent mid-turn wait in a queue tray until Claude reads them; Ctrl+B backgrounds a
 * running command (rich view, and a terminal Claude session where tmux's prefix is also Ctrl+B); context %
 * shows after a turn; a file link in a reply opens in the viewer. Isolated; a few Haiku calls.
 *
 *   node e2e/rich-extras.e2e.mjs [--keep]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = require('playwright');
const KEEP = process.argv.includes('--keep');

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-extras-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-extras-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const env = {
  ...process.env,
  JARVIS_HOME: join(tmp, 'home'), JARVIS_TMUX_SOCKET: SOCKET, JARVIS_REPO_ROOTS: join(tmp, 'repos'),
  JARVIS_USER_DATA: join(tmp, 'electron'), JARVIS_NO_EXTERNAL: '1', JARVIS_NO_PRS: '1', JARVIS_NO_USAGE: '1', JARVIS_TEST_OLD_HOST_MARKER: join(tmp, 'old-host'),
};
for (const k of Object.keys(env)) if (/^(CLAUDE|CLAUDECODE|TMUX|ANTHROPIC_API_KEY)/.test(k)) delete env[k];
const repo = join(tmp, 'repos', 'atlas');
mkdirSync(join(repo, 'docs'), { recursive: true });
writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nThe atlas guide lives here.\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });

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
  }
};

let app;
let win;
let daemonPid = null;
const V = '.rich-wrap:not([style*="none"])';
try {
  app = await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1400, height: 900 }));
  await waitFor(() => win.$('.daemon-dot.ok'), 'daemon', 20_000);
  daemonPid = (await win.evaluate(() => window.jarvis.rpc('snapshot'))).daemon.pid;
  const sess = async (id) => (await win.evaluate(() => window.jarvis.rpc('snapshot'))).sessions.find((x) => x.id === id);
  const turns = () => win.evaluate((v) => document.querySelectorAll(`${v} .rv-turn`).length, V);
  const lastReply = () => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-text .prose`)].at(-1)?.textContent ?? '', V);
  const send = async (text) => {
    await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30_000 });
    await win.fill(`${V} .rv-input`, text);
    await win.press(`${V} .rv-input`, 'Enter');
  };

  const s = await win.evaluate((cwd) => window.jarvis.rpc('sessions.create', {
    cwd, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'auto', name: 'extras',
  }), repo);
  await win.click(`[data-id="${s.id}"]`);

  // 1. Queued message.
  await soft('a message sent mid-turn waits in the queue tray, then goes to Claude when the turn ends and gets answered', async () => {
    const t0 = await turns();
    await send('Run the Bash command `sleep 8 && echo slept` and then reply with just DONE-ONE.');
    await win.waitForSelector(`${V} .rv-work .rv-dot.running, ${V} .rv-tool.running`, { timeout: 60_000 });
    await send(`Also end your reply with the word QUEUED${tag}.`);
    await win.waitForSelector(`${V} .rv-queue-item`, { timeout: 5000 });
    const inline = await win.evaluate(({ v, w }) => [...document.querySelectorAll(`${v} .rv-scroll .rv-user`)].some((e) => e.textContent.includes(w)), { v: V, w: `QUEUED${tag}` });
    if (inline) throw new Error('the queued message is already shown as read in the conversation');
    await win.screenshot({ path: join(ART, 'extras-1-queued.png') });
    await waitFor(async () => (await turns()) > t0 && !(await win.$(`${V} .rv-queue-item`)), 'turn end and empty tray', 90_000);
    const read = await win.evaluate(({ v, w }) => [...document.querySelectorAll(`${v} .rv-scroll .rv-user`)].find((e) => e.textContent.includes(w))?.textContent ?? '', { v: V, w: `QUEUED${tag}` });
    if (!read) throw new Error('the queued message never appeared in the conversation');
    await waitFor(async () => (await win.evaluate((v) => document.querySelector(`${v} .rv-scroll`).innerText, V)).includes(`QUEUED${tag}`), 'answer', 30_000);
    return 'tray → sent at turn end';
  });

  // 2. Context.
  await soft('context % shows in the title bar after a turn', async () => {
    const pct = await waitFor(async () => (await sess(s.id))?.agentState?.context?.usedPct, 'context in agent state', 20_000);
    const chip = await waitFor(() => win.evaluate(() => document.querySelector('.titlebar .chip.ctx')?.textContent ?? ''), 'title bar chip', 5000);
    if (!/ctx \d+%/.test(chip)) throw new Error(`chip "${chip}"`);
    return `${pct.toFixed(1)}%`;
  });

  // 2b. The context panel.
  await soft('/context opens a real breakdown panel (not a text dump), and so does the ctx chip', async () => {
    await send('/context');
    await win.waitForSelector(`${V} .cx .cx-bar`, { timeout: 30_000 });
    const t = await win.locator(`${V} .cx`).innerText();
    if (!/\d+% used/.test(t) || !/System prompt/.test(t) || !/Messages/.test(t) || !/until auto-compact/.test(t)) throw new Error(t.replace(/\s+/g, ' ').slice(0, 200));
    const noDump = await win.evaluate((v) => ![...document.querySelectorAll(`${v} .rv-text .prose table`)].some((x) => /Category/.test(x.textContent)), V);
    if (!noDump) throw new Error('the old text table was rendered too');
    await win.screenshot({ path: join(ART, 'extras-3-context.png') });
    await win.click(`${V} .cx .rv-picker-head .chip-btn`);
    await win.click('.titlebar button.chip.ctx');
    await win.waitForSelector(`${V} .cx .cx-bar`, { timeout: 30_000 });
    await win.locator(`${V} .cx .cx-group-head`).first().click();
    if (await win.locator(`${V} .cx .cx-item`).count() < 1) throw new Error('groups do not expand');
    await win.click(`${V} .cx .rv-picker-head .chip-btn`);
    return t.replace(/\s+/g, ' ').slice(0, 70);
  });

  // 3. Ctrl+B in the rich view.
  await soft('Ctrl+B moves a running command to the background and the turn carries on', async () => {
    const t0 = await turns();
    const started = Date.now();
    // A plain long `sleep` gets refused by Claude Code itself, so use a slow script.
    await send("Run this exact Bash command in the foreground: `python3 -c \"import time; time.sleep(40); print('late')\"`. If it gets moved to the background, don't wait for it: reply with just STARTED right away.");
    await win.waitForSelector(`${V} .rv-work-actions .chip-btn:has-text("Background")`, { timeout: 60_000 });
    await win.focus(`${V} .rv-input`);
    await win.keyboard.press('Control+b');
    await waitFor(() => win.evaluate((v) => /Moved the running task to the background/.test(document.querySelector(`${v} .rv-toast`)?.textContent ?? ''), V), 'Jarvis confirms it backgrounded', 5000);
    await waitFor(async () => (await turns()) > t0, 'turn end', 35_000);
    const took = Math.round((Date.now() - started) / 1000);
    if (took >= 40) throw new Error(`turn took ${took}s, so the command was not backgrounded`);
    return `turn ended after ${took}s; reply: ${(await lastReply()).slice(0, 60)}`;
  });

  // 4. A file link in a reply.
  await soft('a link to a repo file in a reply opens in the viewer', async () => {
    const t0 = await turns();
    await send('Reply with exactly this markdown and nothing else: See [the guide](docs/guide.md#L3).');
    await waitFor(async () => (await turns()) > t0, 'reply', 60_000);
    await win.locator(`${V} .rv-text .prose a[data-href]`).last().click();
    await waitFor(() => win.evaluate(() => document.body.innerText.includes('The atlas guide lives here.')), 'guide in the viewer', 10_000);
  });

  // 4b. Claude's multiple-choice question.
  await soft("Claude's question shows as a card, and the answer you pick comes back to Claude", async () => {
    const t0 = await turns();
    await send('Use the AskUserQuestion tool to ask me which fruit I prefer, with options Mango and Papaya, then reply with just the fruit I chose.');
    await win.waitForSelector(`${V} .rv-ask`, { timeout: 90_000 });
    const text = await win.locator(`${V} .rv-ask`).innerText();
    if (!/Mango/.test(text) || !/Papaya/.test(text)) throw new Error(`options missing: ${text.slice(0, 120)}`);
    const needs = await waitFor(async () => (await sess(s.id))?.agentState?.phase === 'needs_input', 'needs-you state', 10_000).catch(() => false);
    if (!needs) throw new Error('session did not show "needs you"');
    await win.screenshot({ path: join(ART, 'extras-2-question.png') });
    await win.locator(`${V} .rv-ask-opt`, { hasText: 'Papaya' }).click();
    await win.click(`${V} .rv-ask .btn.primary`);
    await waitFor(async () => (await turns()) > t0, 'turn end', 60_000);
    const reply = await lastReply();
    if (!/Papaya/i.test(reply) || /did not answer/i.test(reply)) throw new Error(`reply: ${reply.slice(0, 100)}`);
    const note = await win.evaluate((v) => document.querySelector(`${v} .rv-asked`)?.textContent ?? '', V);
    if (!/Papaya/.test(note)) throw new Error(`no answered line: ${note}`);
    return `answer used: ${reply.slice(0, 30)}`;
  });

  // 4c. The chat opens at the bottom, not the top, after switching away and back.
  await soft('switching away and back opens the chat at the bottom; scrolling up is remembered', async () => {
    const other = await win.evaluate((cwd) => window.jarvis.rpc('sessions.create', { cwd, agent: 'shell', name: 'other' }), repo);
    const gap = () => win.evaluate((v) => { const e = document.querySelector(`${v} .rv-scroll`); return { gap: e.scrollHeight - e.scrollTop - e.clientHeight, tall: e.scrollHeight - e.clientHeight, top: e.scrollTop }; }, V);
    // A short window, so that the conversation is taller than the view.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1400, height: 520 }));
    await sleep(500);
    if ((await gap()).tall < 300) throw new Error('the conversation is not tall enough to test scrolling');
    await win.click(`[data-id="${other.id}"]`);
    await sleep(600);
    await win.click(`[data-id="${s.id}"]`);
    await sleep(600);
    const a = await gap();
    await sleep(1800);
    const a2 = await gap();
    if (a.gap > 60 || a2.gap > 60) throw new Error(`opened ${Math.round(a.gap)}px above the bottom, ${Math.round(a2.gap)}px two seconds later (scrollTop ${Math.round(a.top)} -> ${Math.round(a2.top)}, scrollable ${Math.round(a.tall)} -> ${Math.round(a2.tall)})`);
    // Scroll up, switch away and back: it stays where you were reading.
    const box = await win.locator(`${V} .rv-scroll`).boundingBox();
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.wheel(0, -260); // a real scroll up, like a person's
    await sleep(500);
    const reading = (await gap()).top;
    await win.click(`[data-id="${other.id}"]`);
    await sleep(400);
    await win.click(`[data-id="${s.id}"]`);
    await sleep(600);
    const b = await gap();
    if (Math.abs(b.top - reading) > 40) throw new Error(`scrolled-up position lost: was ${Math.round(reading)}, now ${Math.round(b.top)}`);
    await win.evaluate((v) => { const e = document.querySelector(`${v} .rv-scroll`); e.scrollTop = e.scrollHeight; }, V);
    await sleep(300);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1400, height: 900 }));
    return `at the bottom, then kept ${Math.round(b.top)}px when scrolled up`;
  });

  // 4d. A session whose helper process predates this build says so and can be restarted without losing anything.
  await soft('an outdated helper shows a banner, and Restart keeps the conversation', async () => {
    writeFileSync(join(tmp, 'old-host'), '');
    const old = await win.evaluate((cwd) => window.jarvis.rpc('sessions.create', { cwd, agent: 'claude', model: 'haiku', mode: 'rich', name: 'oldhost' }), repo);
    await win.click(`[data-id="${old.id}"]`);
    await win.waitForSelector(`${V} .rv-outdated`, { timeout: 30_000 });
    const t0 = await turns();
    await send('Reply with exactly the word OLDHOST-REMEMBERS and nothing else.');
    await waitFor(async () => (await turns()) > t0, 'a turn on the old host', 60_000);
    const pidBefore = (await sess(old.id)).rich.hostPid;
    await win.click(`${V} .rv-outdated .btn`);
    await waitFor(async () => { const x = await sess(old.id); return x.rich?.connected && x.rich.hostPid !== pidBefore && !x.rich.outdated; }, 'a current host', 60_000);
    if (await win.locator(`${V} .rv-outdated`).count()) throw new Error('the banner is still shown after the restart');
    await waitFor(async () => (await win.evaluate((v) => document.querySelector(`${v} .rv-scroll`)?.innerText ?? '', V)).includes('OLDHOST-REMEMBERS'), 'history after restart', 20_000);
    return `host ${pidBefore} -> ${(await sess(old.id)).rich.hostPid}`;
  });

  // 5. Ctrl+B in a terminal Claude session goes to Claude Code, not tmux.
  await soft('Ctrl+B in a terminal Claude session reaches Claude Code (not swallowed by tmux)', async () => {
    const t = await win.evaluate((cwd) => window.jarvis.rpc('sessions.create', {
      cwd, agent: 'claude', model: 'haiku', name: 'term', extraArgs: ['--permission-mode', 'auto'],
    }), repo);
    await win.click(`[data-id="${t.id}"]`);
    const cap = () => execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-J', '-S', '-80', '-t', `=${t.tmuxName}:`], { encoding: 'utf8' });
    await waitFor(() => {
      const out = cap();
      if (/trust this folder/i.test(out)) {
        execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `=${t.tmuxName}:`, 'Down']);
        execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `=${t.tmuxName}:`, 'Enter']);
        return false;
      }
      return /^\s*❯\s*$/m.test(out) || /shift\+tab to cycle|\? for shortcuts/i.test(out);
    }, 'Claude Code ready', 60_000, 800);
    execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `=${t.tmuxName}:`, '-l', "Run this exact Bash command in the foreground: `python3 -c \"import time; time.sleep(40); print('late')\"`. If it gets moved to the background, don't wait for it: reply with just STARTED right away."]);
    await sleep(500); // an Enter right behind the text is taken as part of it
    execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `=${t.tmuxName}:`, 'Enter']);
    await waitFor(() => /ctrl\+b to run in background|Running \d+ shell command|Bash\(python3/i.test(cap()), 'the command running', 60_000, 400)
      .catch((e) => {
        console.log('---- terminal ----\n' + cap().split('\n').filter((l) => l.trim()).slice(-22).join('\n') + '\n----');
        throw e;
      });
    // Claude Code registers a command as background-able a few seconds after it starts (same as over the SDK).
    await sleep(6000);
    await win.click('.term-wrap:not([style*="none"]) .xterm');
    await win.keyboard.press('Control+b');
    // Without Ctrl+B this turn takes about 43s (the command sleeps 40s); backgrounded, it ends in a few.
    const out = await waitFor(() => {
      const m = /\w+ for (\d+)s · done/.exec(cap());
      return m ? m : null;
    }, 'the turn to finish', 60_000, 800).catch((e) => {
      console.log('---- terminal ----\n' + cap().split('\n').filter((l) => l.trim()).slice(-18).join('\n') + '\n----');
      throw e;
    });
    if (Number(out[1]) >= 35) throw new Error(`the turn took ${out[1]}s, so Ctrl+B didn't background the command`);
    return `turn took ${out[1]}s instead of ~43s`;
  });
} catch (e) {
  console.error(e);
  check('run completed', false, e.message.split('\n')[0]);
  if (win) await win.screenshot({ path: join(ART, 'extras-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  if (!KEEP) {
    try {
      for (const f of readdirSync(join(tmp, 'home', 'rich'))) {
        if (f.endsWith('.json')) try { process.kill(JSON.parse(readFileSync(join(tmp, 'home', 'rich', f), 'utf8')).pid); } catch { /* gone */ }
      }
    } catch { /* none */ }
    if (daemonPid) try { process.kill(daemonPid, 'SIGTERM'); } catch { /* gone */ }
    try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
    await sleep(2500);
    rmSync(tmp, { recursive: true, force: true });
    const proj = join(homedir(), '.claude/projects');
    for (const d of readdirSync(proj)) if (d.includes(`jarvis-extras-${tag}`)) rmSync(join(proj, d), { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${ART}`);
  process.exit(failed.length ? 1 : 0);
}
