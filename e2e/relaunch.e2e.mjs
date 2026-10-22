#!/usr/bin/env node
/**
 * P0 acceptance test: start Claude sessions in several repos through the UI, quit Jarvis, relaunch it,
 * and check every session reattaches with its process, screen and scrollback intact.
 *
 * Runs against an isolated JARVIS_HOME, tmux socket and Electron profile, in throwaway git repos.
 *
 *   node e2e/relaunch.e2e.mjs [--claude N] [--model haiku] [--keep]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = require('playwright');

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const N_CLAUDE = Number(opt('claude', '5'));
const MODEL = opt('model', 'haiku');
const KEEP = args.includes('--keep');
/** --packaged: drive release/mac-arm64/Jarvis.app instead of the dev build (daemon then starts from the app bundle). */
const PACKAGED = args.includes('--packaged');
const APP_BIN = join(DESKTOP, 'release/mac-arm64/Jarvis.app/Contents/MacOS/Jarvis');

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-e2e-'));
const SOCKET = `jarvis-e2e-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const env = {
  ...process.env,
  JARVIS_HOME: join(tmp, 'home'),
  JARVIS_TMUX_SOCKET: SOCKET,
  JARVIS_REPO_ROOTS: join(tmp, 'repos'),
  JARVIS_USER_DATA: join(tmp, 'electron'),
  JARVIS_NO_EXTERNAL: '1',
  JARVIS_NO_PRS: '1', // keep the test off the network; PR tracking is covered by unit tests
};
for (const k of Object.keys(env)) if (/^(CLAUDE|CLAUDECODE|TMUX)/.test(k)) delete env[k];

const REPOS = ['atlas', 'borealis', 'cygnus'];
for (const r of REPOS) {
  const d = join(tmp, 'repos', r);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'README.md'), `# ${r}\n`);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
  execFileSync('git', ['add', '.'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=e2e@jarvis', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'init'], { cwd: d });
}

// A user-defined agent (stand-in for a local-model CLI such as Pi): prints its argv, then echoes input.
mkdirSync(env.JARVIS_HOME, { recursive: true });
const fakeAgent = join(tmp, 'fake-agent.sh');
writeFileSync(fakeAgent, '#!/bin/sh\necho "FAKE AGENT READY $*"\nexec cat\n', { mode: 0o755 });
writeFileSync(join(env.JARVIS_HOME, 'agents.json'), JSON.stringify([
  { id: 'fake', label: 'Fake Local', command: fakeAgent, glyph: 'ƒ', modelArgs: ['--model', '{model}'] },
], null, 2));

const tmux = (...a) => execFileSync('tmux', ['-L', SOCKET, ...a], { encoding: 'utf8' });
const capture = (name, lines = 80) => tmux('capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', `=${name}:`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function waitFor(fn, what, timeout = 60_000, every = 500) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function launch() {
  const app = PACKAGED
    ? await electron.launch({ executablePath: APP_BIN, args: [], env })
    : await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 60, y: 40, width: 1360, height: 860 }));
  await waitFor(() => win.evaluate(() => document.querySelector('.daemon-dot.ok') !== null), 'daemon connection', 20_000);
  return { app, win };
}

const menu = (app, action, arg) =>
  app.evaluate(({ BrowserWindow }, [a, x]) => BrowserWindow.getAllWindows()[0].webContents.send('menu', a, x), [action, arg]);

const snapshot = (win) => win.evaluate(() => window.jarvis.rpc('snapshot'));

/** Visible text of the xterm attached to a session, read from its buffer. */
const xtermText = (win, id) =>
  win.evaluate((sid) => {
    const t = window.__jarvisTerminals?.get(sid)?.term;
    if (!t) return null;
    const b = t.buffer.active;
    const out = [];
    for (let i = b.viewportY; i < b.viewportY + t.rows; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n');
  }, id);

const AGENT_LABEL = { claude: 'Claude', shell: 'Shell', fake: 'Fake Local' };

async function step(name, fn) {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`${name}: ${e.message.split('\n')[0]}`);
  }
}

const usedRepos = new Set();

async function createViaUi(app, win, repo, agent, model) {
  if (await win.$('.modal')) await win.keyboard.press('Escape');
  await step('dialog closed', () => win.waitForSelector('.modal', { state: 'detached', timeout: 5000 }));
  await menu(app, 'new-session');
  await step('dialog open', () => win.waitForSelector('.modal .modal-input', { timeout: 5000 }));
  await step('repo search', () => win.fill('.modal .modal-input', repo));
  await step(`agent ${agent}`, () => win.click(`.seg-btn:text-is("${AGENT_LABEL[agent]}")`, { timeout: 5000 }));
  if (agent === 'claude') await step('model', () => win.click(`.seg-btn:text-is("${model[0].toUpperCase()}${model.slice(1)}")`, { timeout: 5000 }));
  if (agent === 'fake') await step('model field', () => win.fill('.modal input[placeholder^="Model for"]', model, { timeout: 5000 }));
  // A second session in a checkout that already has one is offered a worktree; these tests mean the same checkout.
  if (agent !== 'shell' && usedRepos.has(repo)) {
    await step(`checkout offer for ${repo} (${agent})`, () => win.waitForSelector('.modal .shared-note', { timeout: 8000 }));
    await step('same checkout', () => win.click('.modal .shared-note .seg-btn:text-is("Same checkout")', { timeout: 5000 }));
  }
  if (agent !== 'shell') usedRepos.add(repo);
  const before = (await snapshot(win)).sessions.length;
  await step('start', () => win.click('.modal .btn.primary', { timeout: 5000 }));
  await waitFor(async () => (await snapshot(win)).sessions.length > before, `session in ${repo}`, 15_000);
  const snap = await snapshot(win);
  return snap.sessions.sort((a, b) => b.createdAt - a.createdAt)[0];
}

let app;
let win;
try {
  log(`tmp ${tmp}, tmux -L ${SOCKET}`);
  ({ app, win } = await launch());

  // 1. Create sessions through the UI: N Claude sessions spread over 3 repos, plus one shell for scrollback.
  const created = [];
  for (let i = 0; i < N_CLAUDE; i++) {
    const s = await createViaUi(app, win, REPOS[i % REPOS.length], 'claude', MODEL);
    created.push(s);
    log(`created ${s.id} ${s.name} in ${s.cwd.split('/').pop()}`);
  }
  const shell = await createViaUi(app, win, REPOS[0], 'shell');
  log(`created shell ${shell.id}`);

  // Agent registry: missing CLIs are disabled; a user-defined agent launches with its model flag.
  await menu(app, 'new-session');
  await win.waitForSelector('.seg-btn:text-is("Fake Local")');
  const missing = await win.$$eval('.seg-btn[disabled]', (els) => els.map((e) => e.textContent));
  check('agents not on PATH are shown disabled', missing.length > 0, missing.join(', '));
  await win.keyboard.press('Escape');
  const fake = await createViaUi(app, win, REPOS[2], 'fake', 'llama3.2:3b');
  await waitFor(() => capture(fake.tmuxName).includes('FAKE AGENT READY --model llama3.2:3b'), 'fake agent output', 20_000);
  check('user-defined agent from agents.json launches with its model flag', true, fake.agent);
  tmux('send-keys', '-t', `=${fake.tmuxName}:`, '-l', 'ping-fake');
  tmux('send-keys', '-t', `=${fake.tmuxName}:`, 'Enter');
  await waitFor(() => capture(fake.tmuxName).split('ping-fake').length >= 3, 'fake agent echo', 10_000);
  const placed = [...created, shell].map((s, i) => s.cwd.endsWith(`/${i < created.length ? REPOS[i % REPOS.length] : REPOS[0]}`));
  check('each session started in the repo picked in the dialog', placed.every(Boolean), placed.map((p) => (p ? 'ok' : 'WRONG')).join(' '));
  check('session names unique', new Set([...created, shell].map((s) => s.name)).size === created.length + 1,
    [...created, shell].map((s) => s.name).join(', '));

  // 2. Get each Claude past the folder trust prompt (defaults to "No, exit") and to its input box.
  for (const s of created) {
    await waitFor(() => {
      const scr = capture(s.tmuxName);
      if (/trust this folder/i.test(scr)) {
        tmux('send-keys', '-t', `=${s.tmuxName}:`, 'Down');
        tmux('send-keys', '-t', `=${s.tmuxName}:`, 'Enter');
        return false;
      }
      return /shift\+tab to cycle|\? for shortcuts/.test(scr);
    }, `claude ready in ${s.id}`, 90_000, 700);
    log(`claude ready in ${s.id}`);
  }

  // 3. Give two sessions real conversation state: a prompt and an answer.
  const prompted = created.slice(0, Math.min(2, created.length));
  for (const [i, s] of prompted.entries()) {
    const word = `PINEAPPLE${i + 1}${s.id.toUpperCase()}`;
    s.word = word;
    tmux('send-keys', '-t', `=${s.tmuxName}:`, '-l', `Reply with exactly the word ${word} and nothing else.`);
    await sleep(300);
    tmux('send-keys', '-t', `=${s.tmuxName}:`, 'Enter');
  }
  for (const s of prompted) {
    await waitFor(() => capture(s.tmuxName).split(s.word).length >= 3, `answer in ${s.id}`, 120_000, 1000);
    log(`answer received in ${s.id}`);
  }

  // 3b. Observers: hook-driven state, activity log, context and plan limits for Claude sessions.
  const p0 = prompted[0];
  const st = await waitFor(async () => {
    const x = (await snapshot(win)).sessions.find((q) => q.id === p0.id)?.agentState;
    return x?.phase === 'done' && x.lastReply?.includes(p0.word) ? x : null;
  }, 'agent state done', 30_000);
  check('hooks drive agent state to done with the reply', true, `${st.phase}: ${st.lastReply}`);
  await waitFor(async () => (await snapshot(win)).sessions.find((q) => q.id === p0.id)?.agentState?.context?.usedPct != null, 'context from status line', 30_000)
    .then(() => check('status line reports context window usage', true))
    .catch(() => check('status line reports context window usage', false));
  const lim = (await snapshot(win)).limits.claude;
  check('plan limits arrive from the status line (Pro/Max only)', !!lim.fiveHour, lim.fiveHour ? `5h ${lim.fiveHour.usedPct}%` : 'none (API-key account?)');

  tmux('send-keys', '-t', `=${p0.tmuxName}:`, '-l', "Use the Bash tool to run exactly: echo JARVIS_TOOL_OK. Then reply DONE.");
  await sleep(300);
  tmux('send-keys', '-t', `=${p0.tmuxName}:`, 'Enter');
  const bash = await waitFor(async () => {
    const acts = await win.evaluate((id) => window.jarvis.rpc('activity.list', { id }), p0.id);
    return acts.find((a) => a.tool === 'Bash' && a.status === 'ok' && a.output?.includes('JARVIS_TOOL_OK'));
  }, 'Bash tool call in activity', 120_000, 1000);
  check('tool call recorded with input, output and duration', !!bash && bash.durationMs != null, `${bash.summary} (${bash.durationMs}ms)`);
  await win.click(`.row[data-id="${p0.id}"]`);
  await menu(app, 'nav-tab', 'activity');
  await win.waitForSelector('.act.tool .act-tool:text-is("Bash")', { timeout: 15_000 });
  check('Activity tab lists the Bash call', true);
  await win.click('.act.tool:has(.act-tool:text-is("Bash")) .act-row');
  await win.waitForSelector('.act-detail pre:has-text("JARVIS_TOOL_OK")', { timeout: 5_000 });
  check('expanding a tool call shows its output', true);
  await win.screenshot({ path: join(ART, 'activity.png') });

  // Quote-reply: select the agent's answer in the terminal, ⌘' pastes it as a quote into the prompt.
  await waitFor(async () => (await snapshot(win)).sessions.find((q) => q.id === p0.id)?.agentState?.phase === 'done', 'turn done', 60_000);
  const selected = await win.evaluate(({ id, word }) => {
    const t = window.__jarvisTerminals.get(id).term;
    const b = t.buffer.active;
    for (let i = b.length - 1; i >= 0; i--) {
      const l = b.getLine(i)?.translateToString(true) ?? '';
      if (l.includes(word) && !l.includes('Reply with')) {
        t.select(l.indexOf(word), i, word.length);
        return t.getSelection();
      }
    }
    return '';
  }, { id: p0.id, word: p0.word });
  await menu(app, 'quote-reply');
  await waitFor(() => capture(p0.tmuxName, 20).includes(`> ${p0.word}`) || /Pasted text/.test(capture(p0.tmuxName, 20)), 'quote in prompt', 10_000)
    .then(() => check("⌘' quotes the selected reply into the prompt", true, selected))
    .catch(() => check("⌘' quotes the selected reply into the prompt", false, `selected "${selected}"`));
  for (let k = 0; k < 60; k++) tmux('send-keys', '-t', `=${p0.tmuxName}:`, 'BSpace');

  // Files: tree, markdown viewer, diff.
  await menu(app, 'nav-tab', 'files');
  await win.click('.tree-row.file:has-text("README.md")');
  await win.waitForSelector('.markdown h1', { timeout: 10_000 });
  check('README.md renders as markdown in the viewer', (await win.textContent('.markdown h1'))?.trim() === p0.cwd.split('/').pop());
  writeFileSync(join(p0.cwd, 'notes.md'), '# Notes\n\n- one\n');
  await menu(app, 'nav-tab', 'changes');
  await win.waitForSelector('.change-row:has-text("notes.md")', { timeout: 10_000 });
  await win.click('.change-row:has-text("notes.md")');
  await win.waitForSelector('.diff .dl.add', { timeout: 10_000 });
  check('a new file shows up in Changes and opens as a diff', true);
  await win.screenshot({ path: join(ART, 'viewer.png') });
  await menu(app, 'nav-tab', 'usage');
  await win.waitForSelector('.big', { timeout: 60_000 });
  check('Pulse renders usage numbers', true);
  await win.screenshot({ path: join(ART, 'pulse.png') });

  // 4. Scrollback in the shell session.
  tmux('send-keys', '-t', `=${shell.tmuxName}:`, '-l', 'seq 1 3000');
  tmux('send-keys', '-t', `=${shell.tmuxName}:`, 'Enter');
  await waitFor(() => /^3000$/m.test(capture(shell.tmuxName, 5)), 'seq output');

  // 5. Look at every session in the UI once, then record state before quitting.
  const order = (await snapshot(win)).sessions.sort((a, b) => a.order - b.order);
  for (const s of order) {
    await win.click(`.row[data-id="${s.id}"]`);
    await sleep(700);
  }
  await win.screenshot({ path: join(ART, 'before-quit.png') });
  const before = new Map();
  for (const s of order) {
    const pid = tmux('display', '-p', '-t', `=${s.tmuxName}:`, '#{pane_pid}').trim();
    before.set(s.id, { pid, screen: capture(s.tmuxName, 0) });
  }

  // 6. Quit Jarvis completely.
  await app.close();
  app = null;
  await sleep(1000);
  const alive = tmux('list-sessions', '-F', '#{session_name}').trim().split('\n');
  check('all tmux sessions survive quitting the app', order.every((s) => alive.includes(s.tmuxName)), `${alive.length} alive`);

  // 7. Relaunch and visit every session.
  ({ app, win } = await launch());
  const snap2 = await snapshot(win);
  check('registry restored after relaunch', snap2.sessions.length === order.length && snap2.sessions.every((s) => s.status === 'running'),
    `${snap2.sessions.length} sessions, ${snap2.sessions.filter((s) => s.status === 'running').length} running`);
  const order2 = snap2.sessions.sort((a, b) => a.order - b.order);
  check('sidebar order preserved', order2.map((s) => s.id).join() === order.map((s) => s.id).join());
  const usedRepos = new Set(order2.map((s) => s.cwd.split('/').pop())).size;
  check(`sessions grouped under ${usedRepos} repos`, new Set(order2.map((s) => s.repoRoot)).size === usedRepos);

  // ⌘1..9 follow the sidebar's on-screen order; check it matches the rows, then visit each by clicking.
  const rowIds = await win.$$eval('.row', (els) => els.map((e) => e.getAttribute('data-id')));
  for (const [i, id] of rowIds.slice(0, 9).entries()) {
    await menu(app, 'goto-session', i);
    await sleep(150);
    const active = await win.$eval('.row.active', (e) => e.getAttribute('data-id'));
    if (active !== id) { check(`⌘${i + 1} selects row ${i + 1}`, false, `got ${active}, want ${id}`); break; }
    if (i === Math.min(rowIds.length, 9) - 1) check('⌘1..9 select sidebar rows in order', true, `${i + 1} rows`);
  }
  for (let i = 0; i < order2.length; i++) {
    const s = order2[i];
    await win.click(`.row[data-id="${s.id}"]`);
    const text = await waitFor(async () => {
      const t = await xtermText(win, s.id);
      return t && t.trim().length > 0 ? t : null;
    }, `xterm content for ${s.id}`, 15_000);
    await sleep(500);
    await win.screenshot({ path: join(ART, `after-${i + 1}-${s.id}.png`) });
    const pid = tmux('display', '-p', '-t', `=${s.tmuxName}:`, '#{pane_pid}').trim();
    check(`${s.name} (${s.id}): same process after relaunch`, pid === before.get(s.id).pid, `pid ${pid}`);
    if (s.agent === 'claude') {
      check(`${s.name} (${s.id}): Claude UI visible after reattach`, /shift\+tab to cycle|\? for shortcuts|Claude Code/.test(text));
      const p = prompted.find((x) => x.id === s.id);
      if (p) {
        const acts = await win.evaluate((id) => window.jarvis.rpc('activity.list', { id }), s.id);
        check(`${s.name} (${s.id}): activity log survives relaunch`, acts.some((a) => a.kind === 'reply' && a.output?.includes(p.word)), `${acts.length} entries`);
        check(`${s.name} (${s.id}): conversation visible after reattach`, text.includes(p.word), p.word);
        // Claude writes the transcript on the first message, at the path Jarvis chose via --session-id.
        check(`${s.name} (${s.id}): transcript at the known session id`, execFileSync('bash', ['-c', `ls ~/.claude/projects/*/${s.agentSessionId}.jsonl 2>/dev/null | wc -l`], { encoding: 'utf8' }).trim() !== '0');
      }
    } else if (s.agent === 'fake') {
      check(`${s.name} (${s.id}): custom agent screen intact`, text.includes('FAKE AGENT READY') && text.includes('ping-fake'));
    } else {
      check(`${s.name} (${s.id}): screen shows end of seq`, /\b3000\b/.test(text));
      const hist = capture(s.tmuxName, 5000);
      check(`${s.name} (${s.id}): scrollback kept in tmux`, /^1$/m.test(hist) && /^1500$/m.test(hist), `${hist.split('\n').length} lines of history`);
    }
  }

  // 8. Typing still reaches the reattached Claude session.
  const first = order2.find((s) => s.agent === 'claude');
  if (first) {
    await win.click(`.row[data-id="${first.id}"]`);
    await sleep(500);
    await win.keyboard.type('hello from the relaunched app');
    await sleep(800);
    check('keyboard input reaches reattached session', capture(first.tmuxName).includes('hello from the relaunched app'));
    for (let k = 0; k < 40; k++) tmux('send-keys', '-t', `=${first.tmuxName}:`, 'BSpace');
  }

  // 9. Reboot case: the tmux session disappears entirely. Jarvis marks it ended; reviving resumes the conversation.
  const victim = prompted[0] && order2.find((s) => s.id === prompted[0].id);
  if (victim) {
    tmux('kill-session', '-t', `=${victim.tmuxName}`);
    await waitFor(async () => (await snapshot(win)).sessions.find((s) => s.id === victim.id)?.status === 'exited', 'session marked ended', 10_000);
    check('killed session shows as ended, not lost', true);
    await win.click(`.row[data-id="${victim.id}"]`);
    await win.waitForSelector('.card .btn.primary');
    await win.screenshot({ path: join(ART, 'ended-card.png') });
    await win.click('.card .btn.primary');
    await waitFor(() => capture(victim.tmuxName, 200).includes(prompted[0].word), 'resumed conversation', 60_000, 1000);
    check('revive resumes the Claude conversation (claude --resume)', true, prompted[0].word);
    await waitFor(async () => (await xtermText(win, victim.id))?.includes(prompted[0].word), 'revived view shows conversation', 15_000);
    check('revived session reattaches in the UI', true);
    await win.screenshot({ path: join(ART, 'revived.png') });
  }
} catch (e) {
  check('run completed', false, e.message);
  if (win) await win.screenshot({ path: join(ART, 'failure.png') }).catch(() => {});
} finally {
  if (app) await app.close().catch(() => {});
  if (!KEEP) {
    try {
      execFileSync(join(ROOT, 'apps/cli/dist/jarvis.cjs'), ['daemon', 'stop'], { env, stdio: 'ignore' });
    } catch { /* ignore */ }
    try {
      tmux('kill-server');
    } catch { /* ignore */ }
    rmSync(`/private/tmp/tmux-${process.getuid()}/${SOCKET}`, { force: true });
    // Agents flush their session files as they exit; give them a moment before removing test-only data.
    await sleep(2500);
    rmSync(tmp, { recursive: true, force: true });
    // Claude wrote transcripts for the throwaway repos; remove only those project dirs.
    try {
      const projects = join(homedir(), '.claude/projects');
      const tag = tmp.split('/').pop(); // jarvis-e2e-XXXXXX, unique to this run
      for (const d of readdirSync(projects)) if (d.includes(`-${tag}-repos-`)) rmSync(join(projects, d), { recursive: true, force: true });
    } catch { /* ignore */ }
  } else {
    log(`kept: JARVIS_HOME=${env.JARVIS_HOME} JARVIS_TMUX_SOCKET=${SOCKET}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${ART}`);
  process.exit(failed.length ? 1 : 0);
}
