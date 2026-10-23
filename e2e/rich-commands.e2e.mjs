#!/usr/bin/env node
/**
 * Slash commands and markdown in the rich view: the / palette, an SDK command, readable markdown (with copy,
 * raw view and file links), the native pickers (/model, /permissions, /status, /copy, /export), /clear then
 * /resume, a screen-only command that reopens the conversation in a terminal, and the switch back.
 * Isolated JARVIS_HOME, tmux socket and Electron profile; a few Haiku calls.
 *
 *   node e2e/rich-commands.e2e.mjs [--keep]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = require('playwright');
const KEEP = process.argv.includes('--keep');

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-cmds-'));
const tag = tmp.split('-').pop().toUpperCase();
const SOCKET = `jarvis-cmds-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const EXPORTS = join(tmp, 'exports');
const env = {
  ...process.env,
  JARVIS_HOME: join(tmp, 'home'), JARVIS_TMUX_SOCKET: SOCKET, JARVIS_REPO_ROOTS: join(tmp, 'repos'),
  JARVIS_USER_DATA: join(tmp, 'electron'), JARVIS_NO_EXTERNAL: '1', JARVIS_NO_PRS: '1', JARVIS_NO_USAGE: '1',
  JARVIS_EXPORT_DIR: EXPORTS, JARVIS_ASSUME_YES: '1',
};
for (const k of Object.keys(env)) if (/^(CLAUDE|CLAUDECODE|TMUX|ANTHROPIC_API_KEY)/.test(k)) delete env[k];

const repo = join(tmp, 'repos', 'atlas');
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, 'README.md'), '# atlas\n\nA test repo.\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e2e@jarvis', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'init'], { cwd: repo });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[cmds ${new Date().toISOString().slice(11, 19)}]`, ...a);
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
    const detail = await fn();
    check(name, true, typeof detail === 'string' ? detail : '');
  } catch (e) {
    check(name, false, e.message.split('\n')[0].slice(0, 200));
    await win?.screenshot({ path: join(ART, `cmds-fail-${results.length}.png`) }).catch(() => {});
  }
};

const savedClipboard = execFileSync('pbpaste', { encoding: 'utf8', env: { ...process.env, LANG: 'en_US.UTF-8' } });
let app;
let win;
let daemonPid = null;
const V = '.rich-wrap:not([style*="none"])';
try {
  app = await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 60, y: 40, width: 1360, height: 900 }));
  await waitFor(() => win.evaluate(() => document.querySelector('.daemon-dot.ok') !== null), 'daemon', 20_000);
  daemonPid = (await win.evaluate(() => window.jarvis.rpc('snapshot'))).daemon.pid;
  const clip = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const snap = () => win.evaluate(() => window.jarvis.rpc('snapshot'));
  const sess = async (id) => (await snap()).sessions.find((s) => s.id === id);
  const replies = () => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-text .prose`)].map((e) => e.textContent), V);
  const lastReply = async () => (await replies()).at(-1) ?? '';
  const typeIn = async (text) => {
    await win.waitForSelector(`${V} .rv-input:not([disabled])`, { timeout: 30_000 });
    await win.fill(`${V} .rv-input`, text);
  };
  const send = async (text) => {
    await typeIn(text);
    await win.press(`${V} .rv-input`, 'Enter');
  };
  const turnEnds = () => win.evaluate((v) => document.querySelectorAll(`${v} .rv-turn`).length, V);

  const s = await win.evaluate((cwd) => window.jarvis.rpc('sessions.create', {
    cwd, agent: 'claude', model: 'haiku', mode: 'rich', permissionMode: 'default', name: 'cmds',
  }), repo);
  await win.click(`[data-id="${s.id}"]`);
  const firstId = s.agentSessionId;
  const WORD = `MANGO${tag}`;

  // 1. Palette.
  await soft('typing / opens the command palette with SDK, Jarvis and terminal commands', async () => {
    await waitFor(async () => {
      await typeIn('/');
      return (await win.$$(`${V} .rv-cmd`)).length > 40;
    }, 'palette with the session\'s commands', 30_000, 1000);
    const badges = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-cmd-badge`)].map((e) => e.textContent), V);
    if (!badges.includes('Jarvis') || !badges.includes('opens terminal')) throw new Error(`badges: ${[...new Set(badges)]}`);
    return `${(await win.$$(`${V} .rv-cmd`)).length} shown`;
  });
  await soft('palette filters as you type', async () => {
    await typeIn('/conte');
    const names = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-cmd-name`)].map((e) => e.textContent), V);
    if (names[0] !== '/context') throw new Error(names.slice(0, 5).join(' '));
  });
  await win.screenshot({ path: join(ART, 'cmds-1-palette.png') });

  // 2. A plain prompt so the first conversation has something to resume to.
  await send(`Reply with exactly the word ${WORD} and nothing else.`);
  await waitFor(async () => (await lastReply()).includes(WORD), 'first reply', 90_000);

  // 3. An SDK command whose output is markdown.
  await soft('/context opens the native context panel with the numbers, and closes with esc', async () => {
    await typeIn('/context');
    await win.press(`${V} .rv-input`, 'Enter');
    await win.waitForSelector(`${V} .cx .cx-bar`, { timeout: 30_000 });
    const t = await win.locator(`${V} .cx`).innerText();
    if (!/\d+% used/.test(t)) throw new Error(t.slice(0, 120));
    await win.click(`${V} .cx .rv-picker-head .chip-btn`);
    if (await win.locator(`${V} .cx`).count()) throw new Error('the panel did not close');
  });

  // 4. Markdown quality.
  const before = await turnEnds();
  await send([
    'Reply with exactly this markdown and nothing else:',
    '## Plan', '- [x] done item', '- [ ] open item', '', '> [!WARNING]', '> careful', '',
    '| Name | Count |', '|---|---|', '| a | 12 |', '| b | 3 |', '', '```python', "print('hi')", '```', '', 'See `README.md`.',
  ].join('\n'));
  await waitFor(async () => (await turnEnds()) > before && (await lastReply()).includes('careful'), 'markdown reply', 90_000);
  await sleep(800);
  const md = await win.evaluate((v) => {
    const last = [...document.querySelectorAll(`${v} .rv-text .prose`)].at(-1);
    return {
      h2: !!last.querySelector('h2'), taskDone: !!last.querySelector('li.pc-task.done'), taskOpen: !!last.querySelector('li.pc-task:not(.done)'),
      callout: !!last.querySelector('blockquote.pc-callout.warning .pc-callout-title'), num: !!last.querySelector('td.num'),
      highlighted: !!last.querySelector('pre.pc-pre code span[style]'), lang: last.querySelector('.pc-lang')?.textContent,
      path: !!last.querySelector('code.pc-path[data-path="README.md"]'),
    };
  }, V);
  check('markdown: heading, task list, callout, numeric table column', md.h2 && md.taskDone && md.taskOpen && md.callout && md.num, JSON.stringify(md));
  check('markdown: code block is highlighted and labelled', md.highlighted && md.lang === 'Python', md.lang ?? '');
  await win.screenshot({ path: join(ART, 'cmds-2-markdown.png') });
  await soft('code block Copy puts the code on the clipboard', async () => {
    await win.locator(`${V} .rv-text .prose .pc-btn[data-act="copy"]`).last().click();
    const c = await clip();
    if (c.trim() !== "print('hi')") throw new Error(JSON.stringify(c));
  });
  await soft('a file path in a reply opens in the viewer', async () => {
    await win.locator(`${V} code.pc-path[data-path="README.md"]`).last().click();
    await waitFor(() => win.evaluate(() => document.body.innerText.includes('A test repo.')), 'README in the viewer', 10_000);
  });
  await soft('Raw shows the reply as markdown source, Copy markdown copies it', async () => {
    const reply = win.locator(`${V} .rv-reply`).last();
    await reply.hover();
    await reply.locator('.pc-btn', { hasText: 'Raw' }).click();
    const raw = await reply.locator('.rv-raw').textContent();
    if (!raw.includes('## Plan') || !raw.includes('- [x] done item')) throw new Error(raw.slice(0, 80));
    await reply.locator('.pc-btn', { hasText: 'Copy markdown' }).click();
    if (!(await clip()).includes('| a | 12 |')) throw new Error('clipboard missing the table source');
    await reply.locator('.pc-btn', { hasText: 'Rendered' }).click();
  });

  // 5. Native commands.
  await soft('/copy copies Claude\'s last reply', async () => {
    await send('/copy');
    await waitFor(async () => (await clip()).includes('## Plan'), 'clipboard', 5000);
  });
  await soft('/status shows model, mode and billing', async () => {
    await send('/status');
    await win.waitForSelector(`${V} .rv-picker`, { timeout: 5000 });
    const t = await win.locator(`${V} .rv-picker`).innerText();
    if (!/Model/.test(t) || !/haiku/i.test(t) || !/your Claude plan/.test(t)) throw new Error(t.replace(/\s+/g, ' ').slice(0, 160));
    await win.keyboard.press('Escape');
    await win.click(`${V} .rv-input`);
  });
  await soft('/permissions picker switches the live permission mode', async () => {
    await send('/permissions');
    await win.waitForSelector(`${V} .rv-picker-filter`, { timeout: 5000 });
    await win.fill(`${V} .rv-picker-filter`, 'plan');
    await win.press(`${V} .rv-picker-filter`, 'Enter');
    await waitFor(() => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-note`)].some((e) => /plan permissions/.test(e.textContent)), V), 'plan mode', 10_000);
    await send('/permissions');
    await win.fill(`${V} .rv-picker-filter`, 'default');
    await win.press(`${V} .rv-picker-filter`, 'Enter');
    await waitFor(() => win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-note`)].at(-1)?.textContent.includes('default permissions'), V), 'default mode', 10_000);
  });
  await soft('/model with no argument opens a model picker and switches', async () => {
    await send('/model');
    await win.waitForSelector(`${V} .rv-picker-filter`, { timeout: 5000 });
    const n = (await win.$$(`${V} .rv-pick`)).length;
    await win.fill(`${V} .rv-picker-filter`, 'haiku');
    await win.press(`${V} .rv-picker-filter`, 'Enter');
    await waitFor(async () => /haiku/i.test(await lastReply()), '/model reply', 20_000);
    return `${n} models`;
  });
  await soft('/export saves the conversation as markdown', async () => {
    await send('/export');
    const f = await waitFor(() => existsSync(EXPORTS) && readdirSync(EXPORTS).find((x) => x.endsWith('.md')), 'export file', 10_000);
    const text = readFileSync(join(EXPORTS, f), 'utf8');
    if (!text.includes('## You') || !text.includes(WORD)) throw new Error(text.slice(0, 120));
    return f;
  });

  // 6. /clear starts a new conversation; /resume goes back.
  await soft('/clear starts a new conversation and the session follows it', async () => {
    await send('/clear');
    const next = await waitFor(async () => {
      const x = await sess(s.id);
      return x.agentSessionId && x.agentSessionId !== firstId ? x.agentSessionId : null;
    }, 'new conversation id', 30_000);
    return `${firstId.slice(0, 8)} -> ${next.slice(0, 8)}`;
  });
  await soft('/resume lists conversations and switches back to the first', async () => {
    await send('/resume');
    await waitFor(async () => (await win.$$(`${V} .rv-pick:not(.muted)`)).length >= 1, 'conversation list', 15_000);
    const labels = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-pick`)].map((e) => e.textContent), V);
    const idx = labels.findIndex((l) => l.includes(firstId.slice(0, 8)));
    if (idx < 0) throw new Error(`first conversation not listed: ${labels.join(' | ').slice(0, 200)}`);
    await win.locator(`${V} .rv-pick`).nth(idx).click();
    await waitFor(async () => (await sess(s.id)).agentSessionId === firstId && (await sess(s.id)).rich?.connected, 'resumed', 30_000);
    await waitFor(() => win.evaluate(({ v, w }) => document.querySelector(`${v} .rv-scroll`)?.innerText.includes(w), { v: V, w: WORD }), 'old history', 15_000);
  });

  // 7. A screen-only command opens the same conversation in Claude Code, with the command typed.
  await soft('a screen-only command reopens the conversation in a terminal and runs there', async () => {
    await send('/powerup');
    const x = await waitFor(async () => {
      const y = await sess(s.id);
      return y.mode === 'terminal' && y.status === 'running' ? y : null;
    }, 'terminal mode', 20_000);
    const screen = await waitFor(() => {
      const out = execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-J', '-S', '-200', '-t', `=${x.tmuxName}:`], { encoding: 'utf8' });
      // A brand-new temp repo gets Claude Code's folder trust prompt (defaults to "No, exit"); your own repos don't.
      if (/trust this folder/i.test(out)) {
        execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `=${x.tmuxName}:`, 'Down']);
        execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `=${x.tmuxName}:`, 'Enter']);
        return null;
      }
      return /powerup|power-up|lesson/i.test(out) ? out : null;
    }, 'command output in Claude Code', 60_000, 800).catch((e) => {
      const out = execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-J', '-S', '-60', '-t', `=${x.tmuxName}:`], { encoding: 'utf8' });
      console.log('---- terminal screen ----\n' + out.split('\n').filter((l) => l.trim()).slice(-25).join('\n') + '\n----');
      throw e;
    });
    await win.screenshot({ path: join(ART, 'cmds-3-terminal.png') });
    return screen.includes(WORD) ? 'conversation history visible' : 'command ran';
  });
  await soft('"rich view" brings it back with the conversation intact', async () => {
    await win.click('button.chip.rich');
    await waitFor(async () => {
      const y = await sess(s.id);
      return y.mode === 'rich' && y.rich?.connected;
    }, 'rich again', 30_000);
    await waitFor(() => win.evaluate(({ v, w }) => document.querySelector(`${v} .rv-scroll`)?.innerText.includes(w), { v: V, w: WORD }), 'history after round trip', 15_000);
    const t = await turnEnds();
    await send('What exact word did I ask you to reply with first? Reply with just that word.');
    await waitFor(async () => (await turnEnds()) > t && (await lastReply()).includes(WORD), 'recall after round trip', 90_000);
  });

  // 7b. /rewind forks instead of destroying: the original transcript is untouched and still resumable.
  await soft('/rewind goes back to before a prompt as a new conversation and leaves the original intact', async () => {
    // Conversation content only: Claude Code also appends bookkeeping lines (cost, mode) when a process closes.
    const messageLines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => /"type":"(user|assistant)"/.test(l)).map((l) => JSON.parse(l).uuid);
    const proj = join(homedir(), '.claude/projects');
    const transcriptOf = (id) => readdirSync(proj).map((d) => join(proj, d, `${id}.jsonl`)).find(existsSync);
    const orig = transcriptOf(firstId);
    const before = messageLines(orig);
    await send('/rewind');
    await waitFor(async () => (await win.$$(`${V} .rv-pick:not(.muted)`)).length >= 2, 'rewind points', 20_000);
    const idx = await win.evaluate((v) => [...document.querySelectorAll(`${v} .rv-pick`)].findIndex((e) => /Reply with exactly this markdown/.test(e.textContent)), V);
    if (idx < 0) throw new Error('the markdown prompt is not offered as a rewind point');
    const points = await win.evaluate(([a]) => window.jarvis.rpc('rich.rewindPoints', { id: a }), [s.id]);
    const promptText = points.find((p) => /Reply with exactly this markdown/.test(p.text))?.text;
    if (!promptText) throw new Error('could not read the prompt text of the rewind point');
    await win.locator(`${V} .rv-pick`).nth(idx).click();
    const forked = await waitFor(async () => {
      const x = await sess(s.id);
      return x.agentSessionId && x.agentSessionId !== firstId && x.rich?.connected ? x.agentSessionId : null;
    }, 'the forked conversation', 60_000);
    await waitFor(async () => (await win.evaluate((v) => document.querySelector(`${v} .rv-scroll`)?.innerText ?? '', V)).includes(WORD), 'history up to the rewind point', 15_000);
    // Like Claude Code, the prompt you rewound to is back in the composer, ready to edit and send again.
    const box = await win.inputValue(`${V} .rv-input`);
    if (box !== promptText) throw new Error(`the composer holds ${JSON.stringify(box.slice(0, 60))}, not the prompt you rewound to`);
    const shown = await win.evaluate((v) => document.querySelector(`${v} .rv-scroll`)?.innerText ?? '', V);
    if (shown.includes('careful')) throw new Error('prompts after the rewind point are still shown');
    const after = messageLines(orig);
    if (after.length < before.length || before.some((u, i) => after[i] !== u)) throw new Error(`the original lost messages: ${before.length} -> ${after.length}`);
    if (!transcriptOf(forked)) throw new Error('no transcript for the fork');
    const t0 = await turnEnds();
    await win.fill(`${V} .rv-input`, '');
    await send('What exact word did I ask you to reply with first? Reply with just that word.');
    await waitFor(async () => (await turnEnds()) > t0 && (await lastReply()).includes(WORD), 'recall in the fork', 90_000);
    return `${firstId.slice(0, 8)} kept, continuing in ${forked.slice(0, 8)}`;
  });

  // 8. /exit stops it.
  await soft('/exit stops the session', async () => {
    await send('/exit');
    await waitFor(async () => (await sess(s.id)).status === 'exited', 'exited', 10_000);
  });
} catch (e) {
  console.error(e);
  check('run completed', false, e.message.split('\n')[0]);
  if (win) await win.screenshot({ path: join(ART, 'cmds-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  execFileSync('pbcopy', { input: savedClipboard });
  if (!KEEP) {
    try {
      for (const f of readdirSync(join(tmp, 'home', 'rich'))) {
        if (!f.endsWith('.json')) continue;
        const { pid } = JSON.parse(readFileSync(join(tmp, 'home', 'rich', f), 'utf8'));
        try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      }
    } catch { /* none */ }
    if (daemonPid) try { process.kill(daemonPid, 'SIGTERM'); } catch { /* gone */ }
    try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
    await sleep(2500);
    rmSync(tmp, { recursive: true, force: true });
    const proj = join(homedir(), '.claude/projects');
    for (const d of readdirSync(proj)) if (d.includes(`jarvis-cmds-${tag.toLowerCase()}`) || d.toLowerCase().includes(`jarvis-cmds-${tag.toLowerCase()}`)) rmSync(join(proj, d), { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${ART}`);
  process.exit(failed.length ? 1 : 0);
}
