#!/usr/bin/env node
/**
 * Layout features: web preview (dev server detection, page renders, compare, device widths), side panel tabs
 * that switch to icons when narrow, the resizable sidebar and its collapsed rail, and the Thinking tab.
 * Isolated JARVIS_HOME, tmux socket and Electron profile; one small Sonnet call for the thinking check.
 *
 *   node e2e/layout.e2e.mjs [--keep]
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = require('playwright');
const KEEP = process.argv.includes('--keep');

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-layout-'));
const tag = tmp.split('-').pop();
const SOCKET = `jarvis-layout-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts');
mkdirSync(ART, { recursive: true });
const env = {
  ...process.env,
  JARVIS_HOME: join(tmp, 'home'), JARVIS_TMUX_SOCKET: SOCKET, JARVIS_REPO_ROOTS: join(tmp, 'repos'),
  JARVIS_USER_DATA: join(tmp, 'electron'), JARVIS_NO_EXTERNAL: '1', JARVIS_NO_PRS: '1', JARVIS_NO_USAGE: '1',
};
for (const k of Object.keys(env)) if (/^(CLAUDE|CLAUDECODE|TMUX|ANTHROPIC_API_KEY)/.test(k)) delete env[k];

const repo = join(tmp, 'repos', 'atlas');
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, 'index.html'), '<!doctype html><title>Atlas Preview</title><h1 id="hi">Hello from atlas</h1>');
writeFileSync(join(repo, 'staging.html'), '<!doctype html><title>Atlas Staging</title><h1>Staging</h1>');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
async function waitFor(fn, what, timeout = 30_000, every = 300) {
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
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

const port = await freePort();
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: repo, stdio: 'ignore' });
let app;
let win;
let daemonPid = null;
try {
  await sleep(800);
  app = await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1500, height: 920 }));
  await waitFor(() => win.evaluate(() => document.querySelector('.daemon-dot.ok') !== null), 'daemon', 20_000);
  daemonPid = (await win.evaluate(() => window.jarvis.rpc('snapshot'))).daemon.pid;
  const menu = (a, x) => app.evaluate(({ BrowserWindow }, [a, x]) => BrowserWindow.getAllWindows()[0].webContents.send('menu', a, x), [a, x]);
  const st = (fn) => win.evaluate(fn);

  const shell = await win.evaluate((cwd) => window.jarvis.rpc('sessions.create', { cwd, agent: 'shell', name: 'atlas shell' }), repo);
  const rich = await win.evaluate((cwd) => window.jarvis.rpc('sessions.create', {
    cwd, agent: 'claude', model: 'sonnet', mode: 'rich', permissionMode: 'default', name: 'atlas rich',
  }), repo);
  await win.click(`[data-id="${shell.id}"]`);

  // Side panel tabs.
  await soft('narrow side panel: icons for every tab, a label only on the active one', async () => {
    await menu('nav-tab', 'activity');
    await win.evaluate(() => window.__jarvisSetState?.({ navWidth: 380 }));
    const r = await st(() => ({ tabs: document.querySelectorAll('.nav-tab').length, icons: document.querySelectorAll('.nav-tab .nav-icon').length, labels: document.querySelectorAll('.nav-tab-label').length, over: (() => { const t = document.querySelector('.nav-tabs'); return t.scrollWidth - t.clientWidth; })() }));
    if (r.labels !== 1 || r.icons !== r.tabs || r.over > 2) throw new Error(JSON.stringify(r));
    return `${r.tabs} tabs fit`;
  });
  await win.screenshot({ path: join(ART, 'layout-1-narrow-nav.png') });
  await soft('wide side panel: every tab labelled', async () => {
    await win.evaluate(() => window.__jarvisSetState?.({ navWidth: 700 }));
    const r = await st(() => ({ tabs: document.querySelectorAll('.nav-tab').length, labels: document.querySelectorAll('.nav-tab-label').length }));
    if (r.labels !== r.tabs) throw new Error(JSON.stringify(r));
    await win.evaluate(() => window.__jarvisSetState?.({ navWidth: 420 }));
  });

  // Sidebar.
  await soft('dragging the sidebar edge resizes it', async () => {
    const box = await win.locator('.sidebar-wrap + .resizer').boundingBox();
    const before = (await win.locator('.sidebar-wrap').boundingBox()).width;
    await win.mouse.move(box.x + 2, box.y + 200);
    await win.mouse.down();
    await win.mouse.move(box.x + 82, box.y + 200, { steps: 6 });
    await win.mouse.up();
    const after = (await win.locator('.sidebar-wrap').boundingBox()).width;
    if (after < before + 60) throw new Error(`${before} -> ${after}`);
    return `${Math.round(before)} -> ${Math.round(after)} px`;
  });
  await soft('dragging it narrow collapses to the icon rail, and ⌘B brings it back', async () => {
    const box = await win.locator('.sidebar-wrap + .resizer').boundingBox();
    await win.mouse.move(box.x + 2, box.y + 200);
    await win.mouse.down();
    await win.mouse.move(80, box.y + 200, { steps: 8 });
    await win.mouse.up();
    await win.waitForSelector('.sidebar.rail', { timeout: 3000 });
    const items = await win.$$('.rail-item');
    if (items.length !== 2) throw new Error(`${items.length} rail items`);
    await win.screenshot({ path: join(ART, 'layout-2-rail.png') });
    await win.click(`.rail-item[data-id="${rich.id}"]`);
    const active = await st(() => document.querySelector('.titlebar .tb-name')?.textContent);
    if (active !== 'atlas rich') throw new Error(`clicking a rail icon did not switch (${active})`);
    await menu('toggle-sidebar');
    await win.waitForSelector('.sidebar-wrap .sidebar', { timeout: 3000 });
  });

  // Web preview.
  await win.click(`[data-id="${shell.id}"]`);
  await soft('⇧⌘B lists the dev server running in this repo first', async () => {
    await menu('open-preview');
    await win.waitForSelector('.modal .opt', { timeout: 5000 });
    const first = await waitFor(async () => {
      const t = await win.locator('.modal .opt-list .opt').first().innerText();
      return t.includes(`:${port}`) ? t : null;
    }, 'dev server in the list', 10_000);
    if (!/this repo/.test(first)) throw new Error(first);
    return first.replace(/\s+/g, ' ').trim();
  });
  await soft('the page renders in the preview pane beside the terminal', async () => {
    await win.press('.modal .modal-input', 'Enter');
    await win.waitForSelector('.web-preview webview', { timeout: 5000 });
    const title = await waitFor(() => win.evaluate(() => {
      const v = document.querySelector('.web-preview webview');
      try { return v.getTitle(); } catch { return null; }
    }), 'page title', 15_000);
    if (title !== 'Atlas Preview') throw new Error(title);
    const termVisible = await st(() => !!document.querySelector('.term-wrap:not([style*="none"]) .xterm'));
    if (!termVisible) throw new Error('terminal is not visible next to the preview');
    return title;
  });
  await soft('Compare shows a second page side by side', async () => {
    await win.click('.wp-tools .chip-btn:has-text("Compare")');
    await win.waitForSelector('.wp-panes.two .wp-pane:nth-child(2) webview', { timeout: 5000 });
    const url2 = win.locator('.wp-pane').nth(1).locator('.wp-url');
    await url2.fill(`localhost:${port}/staging.html`);
    await url2.press('Enter');
    const titles = await waitFor(async () => {
      const t = await st(() => [...document.querySelectorAll('.web-preview webview')].map((v) => { try { return v.getTitle(); } catch { return ''; } }));
      return t[1] === 'Atlas Staging' ? t : null;
    }, 'second page', 15_000);
    return titles.join(' | ');
  });
  await soft('a device width renders the page at that width', async () => {
    await win.click('.wp-tools .seg-btn:text-is("390")');
    await sleep(500);
    const w = await win.evaluate(() => document.querySelector('.web-preview webview').executeJavaScript('window.innerWidth'));
    if (Math.abs(w - 390) > 2) throw new Error(`page sees ${w}px`);
    return `page width ${w}px`;
  });
  await win.screenshot({ path: join(ART, 'layout-3-preview.png') });

  // Thinking.
  await win.click(`[data-id="${rich.id}"]`);
  await soft('thinking shows in the rich view and in the Thinking tab', async () => {
    await win.waitForSelector('.rich-wrap:not([style*="none"]) .rv-input:not([disabled])', { timeout: 30_000 });
    // Adaptive thinking skips easy questions, so raise effort and ask something that needs working out.
    await win.fill('.rich-wrap:not([style*="none"]) .rv-input', '/effort max');
    await win.press('.rich-wrap:not([style*="none"]) .rv-input', 'Enter');
    await waitFor(() => st(() => /effort/i.test(document.querySelector('.rich-wrap:not([style*="none"]) .rv-scroll')?.innerText ?? '')), 'effort set', 20_000);
    await win.fill('.rich-wrap:not([style*="none"]) .rv-input',
      'Work this out carefully before answering. Find the smallest positive integer n such that n leaves remainder 2 when divided by 3, remainder 3 when divided by 5, remainder 2 when divided by 7, and is divisible by 11. Reply with just the number.');
    await win.press('.rich-wrap:not([style*="none"]) .rv-input', 'Enter');
    await waitFor(() => st(() => document.querySelectorAll('.rich-wrap:not([style*="none"]) .rv-turn').length > 0), 'reply', 120_000);
    await menu('nav-tab', 'thinking');
    const n = await waitFor(async () => {
      const head = await st(() => document.querySelector('.navigator .nav-head')?.textContent ?? '');
      const m = /(\d+) thoughts?/.exec(head);
      return m && Number(m[1]) > 0 ? head : null;
    }, 'thoughts in the tab', 30_000, 1000);
    const card = await st(() => document.querySelector('.rich-wrap:not([style*="none"]) .rv-think-preview')?.textContent ?? '');
    if (!card.trim()) throw new Error('rich view thinking card has no text');
    return `${n.trim()} · card: ${card.slice(0, 60)}…`;
  });
  await win.locator('.think-meta').first().click().catch(() => {});
  await win.screenshot({ path: join(ART, 'layout-4-thinking.png') });

  // Thinking density in the rich view: the switch under the composer, View → Thinking, and ⌥⌘T.
  const V = '.rich-wrap:not([style*="none"])';
  const count = (sel) => st((x) => document.querySelectorAll(x).length).catch(() => 0);
  const q = (sel) => win.evaluate((x) => document.querySelectorAll(x).length, sel);
  void count;
  const menuDensity = () => app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu().items.find((x) => x.label === 'View');
    return view.submenu.items.find((x) => x.label === 'Thinking').submenu.items.find((x) => x.checked)?.label ?? null;
  });
  await soft('Normal folds thinking into a row you can open in the chat', async () => {
    if (await q(`${V} .rv-think-group`) < 1) throw new Error('no folded thinking row');
    const preview = await win.locator(`${V} .rv-think-group .rv-think-preview`).first().innerText();
    await win.locator(`${V} .rv-think-head`).first().click();
    if (await q(`${V} .rv-think-group.open .rv-think-para .prose`) < 1) throw new Error('opening it shows no text');
    const m = await menuDensity();
    if (!/^Normal/.test(m ?? '')) throw new Error(`menu shows ${m}`);
    return `preview: ${preview.slice(0, 50)}…`;
  });
  await soft('Detailed (from the composer switch) shows thinking expanded inline', async () => {
    await win.click(`${V} .rv-density .seg-btn:text-is("Detailed")`);
    if (await q(`${V} .rv-think-open .rv-think-para .prose`) < 1) throw new Error('no expanded thinking');
    if (await q(`${V} .rv-think-group`) !== 0) throw new Error('folded rows still shown');
    const m = await menuDensity();
    if (!/^Detailed/.test(m ?? '')) throw new Error(`menu shows ${m}`);
  });
  await win.screenshot({ path: join(ART, 'layout-5-detailed.png') });
  await soft('Focus (from View → Thinking) hides thinking; ⌥⌘T cycles back to Normal', async () => {
    await app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu().items.find((x) => x.label === 'View');
      view.submenu.items.find((x) => x.label === 'Thinking').submenu.items.find((x) => /^Focus/.test(x.label)).click();
    });
    await sleep(300);
    if (await q(`${V} .rv-think-group, ${V} .rv-think-open`) !== 0) throw new Error('thinking still visible in Focus');
    await menu('cycle-density');
    await sleep(300);
    if (await q(`${V} .rv-think-group`) < 1) throw new Error('cycle did not return to Normal');
    return (await menuDensity()) ?? '';
  });
} catch (e) {
  console.error(e);
  check('run completed', false, e.message.split('\n')[0]);
  if (win) await win.screenshot({ path: join(ART, 'layout-failure.png') }).catch(() => {});
} finally {
  http.kill();
  await app?.close().catch(() => {});
  if (!KEEP) {
    try {
      for (const f of readdirSync(join(tmp, 'home', 'rich'))) {
        if (!f.endsWith('.json')) continue;
        try { process.kill(JSON.parse(readFileSync(join(tmp, 'home', 'rich', f), 'utf8')).pid, 'SIGTERM'); } catch { /* gone */ }
      }
    } catch { /* none */ }
    if (daemonPid) try { process.kill(daemonPid, 'SIGTERM'); } catch { /* gone */ }
    try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
    await sleep(2500);
    rmSync(tmp, { recursive: true, force: true });
    const proj = join(homedir(), '.claude/projects');
    for (const d of readdirSync(proj)) if (d.includes(`jarvis-layout-${tag}`)) rmSync(join(proj, d), { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${ART}`);
  process.exit(failed.length ? 1 : 0);
}
