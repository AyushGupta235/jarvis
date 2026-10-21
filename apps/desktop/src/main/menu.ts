import { Menu, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '../shared/ipc';
import { DENSITIES, MONO_FONTS, THEMES, UI_FONTS, type AppearanceState } from '../shared/themes';

export function buildMenu(getWin: () => BrowserWindow | null, onMaximize: () => void, isDev: boolean, look: AppearanceState): void {
  const send = (action: MenuAction, arg?: number | string) => () => getWin()?.webContents.send('menu', action, arg);
  const item = (label: string, accelerator: string | undefined, action: MenuAction, arg?: number | string): MenuItemConstructorOptions => ({
    label, accelerator, click: send(action, arg),
  });

  const radio = (label: string, checked: boolean, action: MenuAction, arg: string, missing = false): MenuItemConstructorOptions => ({
    label: missing ? `${label} (not installed)` : label, type: 'radio', checked, enabled: !missing, click: send(action, arg),
  });

  const gotoItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? 'Last Session' : `Session ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: send('goto-session', i === 8 ? -1 : i),
  }));

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Jarvis (sessions keep running)' },
      ],
    },
    {
      label: 'Session',
      submenu: [
        item('New Session…', 'CmdOrCtrl+T', 'new-session'),
        item('New Session in This Repo', 'CmdOrCtrl+Shift+T', 'new-session-here'),
        item('Quick Switch…', 'CmdOrCtrl+P', 'quick-switch'),
        item('Next Session Needing You', 'CmdOrCtrl+Shift+U', 'next-attention'),
        item('Quote Selection in Reply', "CmdOrCtrl+'", 'quote-reply'),
        { type: 'separator' },
        item('Rename Session…', 'CmdOrCtrl+Shift+R', 'rename-session'),
        item('Hide Session (keeps running)', 'CmdOrCtrl+W', 'hide-session'),
        item('End Session…', 'CmdOrCtrl+Shift+W', 'end-session'),
        { type: 'separator' },
        item('Next Session', 'CmdOrCtrl+Shift+]', 'next-session'),
        item('Previous Session', 'CmdOrCtrl+Shift+[', 'prev-session'),
        item('Move Session Up', 'CmdOrCtrl+Alt+Up', 'move-up'),
        item('Move Session Down', 'CmdOrCtrl+Alt+Down', 'move-down'),
        { label: 'Go To', submenu: gotoItems },
        { type: 'separator' },
        item('Show Hidden Sessions', 'CmdOrCtrl+Shift+H', 'toggle-hidden'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find in Scrollback', 'CmdOrCtrl+F', 'find'),
        item('Copy Mode', 'CmdOrCtrl+Shift+X', 'copy-mode'),
        item('Clear Scrollback', 'CmdOrCtrl+K', 'clear'),
      ],
    },
    {
      label: 'Pane',
      submenu: [
        item('Split Right', 'CmdOrCtrl+D', 'split-right'),
        item('Split Down', 'CmdOrCtrl+Shift+D', 'split-down'),
        item('Zoom Pane', 'CmdOrCtrl+Z', 'zoom-pane'),
        { type: 'separator' },
        item('Focus Left', 'CmdOrCtrl+Shift+Left', 'pane-left'),
        item('Focus Right', 'CmdOrCtrl+Shift+Right', 'pane-right'),
        item('Focus Up', 'CmdOrCtrl+Shift+Up', 'pane-up'),
        item('Focus Down', 'CmdOrCtrl+Shift+Down', 'pane-down'),
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        item('Toggle Navigator', 'CmdOrCtrl+J', 'toggle-navigator'),
        item('Open File…', 'CmdOrCtrl+O', 'quick-open'),
        item('Open Web Preview…', 'CmdOrCtrl+Shift+B', 'open-preview'),
        item('Toggle File Viewer', 'CmdOrCtrl+\\', 'toggle-viewer'),
        item('Close Viewer Tab', 'CmdOrCtrl+Alt+W', 'close-viewer-tab'),
        { type: 'separator' },
        item('Activity', 'CmdOrCtrl+Alt+1', 'nav-tab', 'activity'),
        item('Files', 'CmdOrCtrl+Alt+2', 'nav-tab', 'files'),
        item('Changes', 'CmdOrCtrl+Alt+3', 'nav-tab', 'changes'),
        item('Docs', 'CmdOrCtrl+Alt+4', 'nav-tab', 'docs'),
        item('Pull Requests', 'CmdOrCtrl+Alt+5', 'nav-tab', 'prs'),
        item('Connectors', 'CmdOrCtrl+Alt+6', 'nav-tab', 'connectors'),
        item('Usage', 'CmdOrCtrl+Alt+7', 'nav-tab', 'usage'),
        item('Thinking', 'CmdOrCtrl+Alt+8', 'nav-tab', 'thinking'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Collapse Sidebar', 'CmdOrCtrl+B', 'toggle-sidebar'),
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            { label: 'Jarvis Originals', enabled: false },
            ...THEMES.filter((t) => t.original).map((t) => radio(`${t.label}${t.kind === 'light' ? ' (light)' : ''}`, look.theme === t.id, 'set-theme', t.id)),
            { type: 'separator' },
            { label: 'Dark Classics', enabled: false },
            ...THEMES.filter((t) => !t.original && t.kind === 'dark').map((t) => radio(t.label, look.theme === t.id, 'set-theme', t.id)),
            { type: 'separator' },
            { label: 'Light Classics', enabled: false },
            ...THEMES.filter((t) => !t.original && t.kind === 'light').map((t) => radio(t.label, look.theme === t.id, 'set-theme', t.id)),
          ],
        },
        {
          label: 'Thinking',
          submenu: [
            ...DENSITIES.map((d) => radio(`${d.label}: ${d.detail.toLowerCase()}`, look.density === d.id, 'set-density', d.id)),
            { type: 'separator' },
            item('Next Thinking View', 'CmdOrCtrl+Alt+T', 'cycle-density'),
          ],
        },
        {
          label: 'Interface Font',
          submenu: UI_FONTS.map((f) => radio(f.label, look.uiFont === f.id, 'set-ui-font', f.id, look.missingFonts.includes(f.id))),
        },
        {
          label: 'Terminal Font',
          submenu: MONO_FONTS.map((f) => radio(f.label, look.monoFont === f.id, 'set-mono-font', f.id, look.missingFonts.includes(f.id))),
        },
        { type: 'separator' },
        item('Bigger Text', 'CmdOrCtrl+=', 'font-bigger'),
        item('Smaller Text', 'CmdOrCtrl+-', 'font-smaller'),
        item('Actual Size', 'CmdOrCtrl+0', 'font-reset'),
        { type: 'separator' },
        { label: 'Fill Screen', accelerator: 'CmdOrCtrl+Enter', click: onMaximize },
        { role: 'togglefullscreen', accelerator: 'CmdOrCtrl+Shift+Enter' },
        { type: 'separator' },
        { role: 'toggleDevTools', accelerator: 'Alt+CmdOrCtrl+I' },
        ...(isDev ? [{ role: 'reload' } as MenuItemConstructorOptions] : []),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
