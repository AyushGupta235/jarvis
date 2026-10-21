import { BrowserWindow, Menu, Notification, app, clipboard, dialog, ipcMain, nativeTheme, shell, type Rectangle } from 'electron';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AttachSpec, Snapshot } from '@jarvis/protocol';
import type { AttentionEvent, ContextMenuItem } from '../shared/ipc';
import { DaemonClient } from './daemon';
import { PtyManager, ensureSpawnHelper } from './pty';
import { buildMenu } from './menu';
import { DEFAULT_MONO_FONT, DEFAULT_THEME, DEFAULT_UI_FONT, THEMES, type AppearanceState } from '../shared/themes';
import { loadBounds, toggleMaximize, trackBounds } from './windowState';

app.setName('Jarvis');
if (process.env.JARVIS_USER_DATA) app.setPath('userData', process.env.JARVIS_USER_DATA);

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;

function daemonBundlePath(): string {
  if (process.env.JARVIS_DAEMON_BUNDLE) return process.env.JARVIS_DAEMON_BUNDLE;
  if (app.isPackaged) return join(process.resourcesPath, 'jarvisd.cjs');
  return resolve(app.getAppPath(), '../../packages/daemon/dist/jarvisd.cjs');
}

const daemon = new DaemonClient(daemonBundlePath());
const ptys = new PtyManager();
const maximized = new Map<number, Rectangle>();
let win: BrowserWindow | null = null;
let activeSessionId: string | null = null;

function createWindow(): void {
  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 400,
    title: 'Jarvis',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // The web preview pane (Viewer → Preview) is a <webview>; will-attach-webview below locks it down.
      webviewTag: true,
    },
  });
  trackBounds(win);
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Preview webviews: no preload, no Node, sandboxed, own cookie jar, and only http(s) pages.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    const src = params.src ?? '';
    if (!/^https?:\/\//.test(src) && src !== 'about:blank') e.preventDefault();
  });
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  const wc = win.webContents;
  win.on('closed', () => {
    ptys.closeAllFor(wc);
    win = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerIpc(): void {
  ipcMain.handle('rpc', (_e, method: string, params: unknown) => daemon.rpc(method, params));
  ipcMain.handle('daemon:state', () => ({ snapshot: daemon.snapshot, status: { connected: daemon.connected } }));
  ipcMain.handle('pty:open', async (e, sessionId: string, cols: number, rows: number) => {
    const spec = await daemon.rpc<AttachSpec>('sessions.attachSpec', { id: sessionId });
    return ptys.open(e.sender, spec, cols, rows);
  });
  ipcMain.on('pty:write', (_e, id: number, data: string) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id: number, cols: number, rows: number) => ptys.resize(id, cols, rows));
  ipcMain.on('pty:close', (_e, id: number) => ptys.close(id));
  ipcMain.handle('dialog:chooseDirectory', async (_e, defaultPath?: string) => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      defaultPath: defaultPath || join(homedir(), 'code'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.handle('dialog:confirm', async (_e, message: string, detail: string, okLabel: string) => {
    if (!win) return false;
    const r = await dialog.showMessageBox(win, { type: 'warning', message, detail, buttons: [okLabel, 'Cancel'], defaultId: 0, cancelId: 1 });
    return r.response === 0;
  });
  ipcMain.handle('contextMenu', (_e, items: ContextMenuItem[]) =>
    new Promise<string | null>((resolvePick) => {
      let picked: string | null = null;
      const menu = Menu.buildFromTemplate(items.map((i) =>
        i.type === 'separator'
          ? { type: 'separator' as const }
          : { label: i.label, enabled: i.enabled !== false, click: () => { picked = i.id ?? null; } },
      ));
      menu.popup({ window: win ?? undefined, callback: () => setTimeout(() => resolvePick(picked), 0) });
    }),
  );
  ipcMain.on('openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.on('revealPath', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.on('ui:state', (_e, activeId: string | null, badge: number) => {
    activeSessionId = activeId;
    app.dock?.setBadge(badge > 0 ? String(badge) : '');
  });
  ipcMain.on('copyText', (_e, t: string) => clipboard.writeText(t));
}

daemon.on('snapshot', (s) => win?.webContents.send('snapshot', s));
daemon.on('status', (s) => win?.webContents.send('daemon:status', s));
daemon.on('activity', (e) => win?.webContents.send('activity', e));
daemon.on('files.changed', (e) => win?.webContents.send('files.changed', e));
daemon.on('rich.event', (e) => win?.webContents.send('rich.event', e));
daemon.on('attention', (a: AttentionEvent) => {
  win?.webContents.send('attention', a);
  // Notify only when you can't already see it: another session is on screen, or Jarvis isn't focused.
  if (win && win.isFocused() && activeSessionId === a.sessionId) return;
  const s = (daemon.snapshot as Snapshot | null)?.sessions.find((x) => x.id === a.sessionId);
  const name = s?.agentState?.title || s?.name || 'Session';
  const body = a.phase === 'needs_input' ? a.message || 'Needs your input' : s?.agentState?.lastReply?.slice(0, 180) || 'Finished';
  const n = new Notification({ title: a.phase === 'needs_input' ? `${name} needs you` : `${name} is done`, body, silent: a.phase !== 'needs_input' });
  n.on('click', () => {
    win?.show();
    win?.focus();
    win?.webContents.send('menu', 'goto-session-id', a.sessionId);
  });
  n.show();
});

/** The renderer's theme and fonts (View menu), mirrored here for the menu's checkmarks and the window chrome. */
let look: AppearanceState = { theme: DEFAULT_THEME, uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT, missingFonts: [] };

function applyLook(): void {
  // Match macOS chrome (vibrancy, dialogs, menus, scrollbars) to the theme, whatever the system appearance is.
  nativeTheme.themeSource = THEMES.find((t) => t.id === look.theme)?.kind ?? 'dark';
  buildMenu(() => win, () => win && toggleMaximize(win, maximized), isDev, look);
}

ipcMain.on('ui:appearance', (_e, a: AppearanceState) => {
  look = a;
  applyLook();
});

app.whenReady().then(() => {
  ensureSpawnHelper();
  registerIpc();
  applyLook();
  daemon.start();
  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Closing the window detaches from tmux; sessions keep running. Quit fully, like a terminal.
  app.quit();
});

app.on('before-quit', () => {
  ptys.closeAll();
  daemon.close();
});
