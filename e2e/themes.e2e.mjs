#!/usr/bin/env node
/**
 * Themes and fonts (View → Theme / Interface Font / Terminal Font): every theme applies to the app, the
 * terminal and code highlighting, keeps text readable, checks itself in the menu and sets macOS's light or
 * dark chrome; fonts apply and load; the choice survives a relaunch. Writes a contact sheet of all themes.
 * No agent calls.
 *
 *   node e2e/themes.e2e.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const require = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = require('playwright');

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-themes-'));
const SOCKET = `jarvis-themes-${process.pid}`;
const ART = join(ROOT, 'e2e/.artifacts/themes');
mkdirSync(ART, { recursive: true });
const env = {
  ...process.env,
  JARVIS_HOME: join(tmp, 'home'), JARVIS_TMUX_SOCKET: SOCKET, JARVIS_REPO_ROOTS: join(tmp, 'repos'),
  JARVIS_USER_DATA: join(tmp, 'electron'), JARVIS_NO_EXTERNAL: '1', JARVIS_NO_PRS: '1', JARVIS_NO_USAGE: '1',
};
for (const k of Object.keys(env)) if (/^(CLAUDE|CLAUDECODE|TMUX)/.test(k)) delete env[k];
const repo = join(tmp, 'repos', 'atlas');
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, 'app.ts'), 'export function greet(name: string): string {\n  // say hello\n  return `hi ${name}`;\n}\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function launch() {
  const app = await electron.launch({ executablePath: require('electron'), args: [DESKTOP], env });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('pageerror', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1400, height: 860 }));
  for (let i = 0; i < 60 && !(await win.$('.daemon-dot.ok')); i++) await sleep(300);
  return { app, win };
}

let app;
let win;
let daemonPid = null;
try {
  ({ app, win } = await launch());
  daemonPid = (await win.evaluate(() => window.jarvis.rpc('snapshot'))).daemon.pid;
  const menu = (a, x) => app.evaluate(({ BrowserWindow }, [a, x]) => BrowserWindow.getAllWindows()[0].webContents.send('menu', a, x), [a, x]);
  const s = await win.evaluate((cwd) => window.jarvis.rpc('sessions.create', { cwd, agent: 'shell' }), repo);
  await win.click(`[data-id="${s.id}"]`);
  await sleep(800);
  execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `=${s.tmuxName}:`, "clear; printf '\\e[31mred \\e[32mgreen \\e[33myellow \\e[34mblue \\e[35mmagenta \\e[36mcyan\\e[0m\\n'; ls", 'Enter']);
  await win.evaluate((p) => window.__jarvisSetState({ viewerOpen: true, viewerTabs: [{ path: p, root: null, mode: 'file' }], viewerActive: 0 }), join(repo, 'app.ts'));
  await sleep(1200);

  const themes = await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu().items.find((i) => i.label === 'View');
    const theme = view.submenu.items.find((i) => i.label === 'Theme');
    return theme.submenu.items.filter((i) => i.type === 'radio').map((i) => ({ label: i.label, checked: i.checked }));
  });
  check('View → Theme lists the built-in themes', themes.length >= 14, `${themes.length} themes, checked: ${themes.find((t) => t.checked)?.label}`);

  const luminance = (hex) => {
    const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };

  const ids = await win.evaluate(() => document.documentElement.dataset.theme);
  const shots = [];
  const allIds = await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu().items.find((i) => i.label === 'View');
    return view.submenu.items.find((i) => i.label === 'Theme').submenu.items.filter((i) => i.type === 'radio').map((i) => i.label);
  });
  const bad = [];
  for (let i = 0; i < allIds.length; i++) {
    // Click the real menu item, like a person would.
    await app.evaluate(({ Menu }, label) => {
      const view = Menu.getApplicationMenu().items.find((x) => x.label === 'View');
      view.submenu.items.find((x) => x.label === 'Theme').submenu.items.find((x) => x.label === label).click();
    }, allIds[i]);
    // Each theme's Shiki theme loads on first use; wait for the viewer's code to be re-highlighted.
    for (let k = 0; k < 30 && !(await win.evaluate(() => !!document.querySelector('.viewer span[style*="color"]'))); k++) await sleep(150);
    await sleep(300);
    const st = await win.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const t = window.__jarvisTerminals.values().next().value?.term;
      const span = document.querySelector('.viewer .code-line span[style], .viewer span[style*="color"]');
      return {
        id: document.documentElement.dataset.theme, base: css.getPropertyValue('--base').trim(), text: css.getPropertyValue('--text').trim(),
        muted: css.getPropertyValue('--muted').trim(), subtle: css.getPropertyValue('--subtle').trim(),
        termFg: t?.options.theme.foreground, termRed: t?.options.theme.red, scheme: css.colorScheme, codeColor: span?.style.color ?? null,
      };
    });
    const menuState = await app.evaluate(({ Menu, nativeTheme }) => {
      const view = Menu.getApplicationMenu().items.find((x) => x.label === 'View');
      return { checked: view.submenu.items.find((x) => x.label === 'Theme').submenu.items.find((x) => x.checked)?.label, dark: nativeTheme.shouldUseDarkColors };
    });
    const c = contrast(st.text, st.base);
    const cs = contrast(st.subtle, st.base);
    const ok = st.termFg === st.text && menuState.checked === allIds[i] && c >= 4.5 && cs >= 3 && menuState.dark === (st.scheme === 'dark') && !!st.codeColor;
    if (!ok) bad.push(`${allIds[i]}: ${JSON.stringify({ ...st, ...menuState, c: c.toFixed(1), cs: cs.toFixed(1) })}`);
    const file = join(ART, `${String(i).padStart(2, '0')}-${st.id}.png`);
    await win.screenshot({ path: file });
    shots.push({ file, label: allIds[i], c: c.toFixed(1) });
  }
  check('every theme reaches the app, terminal, code and menu, with readable contrast', !bad.length, bad.length ? bad.join(' | ').slice(0, 600) : `${allIds.length} themes`);
  void ids;

  // Fonts.
  await menu('set-mono-font', 'fira-code');
  await sleep(1200);
  const mono = await win.evaluate(() => ({
    term: window.__jarvisTerminals.values().next().value?.term.options.fontFamily,
    loaded: document.fonts.check("13px 'Fira Code Variable'"),
  }));
  check('Terminal Font switches the terminal font and the bundled font loads', /Fira Code/.test(mono.term) && mono.loaded, mono.term);
  await menu('set-ui-font', 'inter');
  await sleep(500);
  const ui = await win.evaluate(() => getComputedStyle(document.body).fontFamily);
  check('Interface Font switches the app font', /Inter Variable/.test(ui), ui.slice(0, 50));

  // Persistence.
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu().items.find((x) => x.label === 'View');
    view.submenu.items.find((x) => x.label === 'Theme').submenu.items.find((x) => x.label === 'Tokyo Night').click();
  });
  await sleep(500);
  await app.close();
  ({ app, win } = await launch());
  await sleep(1000);
  const after = await win.evaluate(() => ({ id: document.documentElement.dataset.theme, ui: getComputedStyle(document.body).fontFamily }));
  const menuAfter = await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu().items.find((x) => x.label === 'View');
    return view.submenu.items.find((x) => x.label === 'Theme').submenu.items.find((x) => x.checked)?.label;
  });
  check('theme and fonts survive a relaunch', after.id === 'tokyo-night' && /Inter/.test(after.ui) && menuAfter === 'Tokyo Night', `${after.id}, menu: ${menuAfter}`);
  writeFileSync(join(ART, 'shots.json'), JSON.stringify(shots));
} catch (e) {
  console.error(e);
  check('run completed', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  if (daemonPid) try { process.kill(daemonPid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1500);
  rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${ART}`);
  process.exit(failed.length ? 1 : 0);
}
