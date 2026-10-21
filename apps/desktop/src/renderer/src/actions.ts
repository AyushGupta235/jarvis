import type { SessionInfo } from '@jarvis/protocol';
import type { MenuAction } from '../../shared/ipc';
import { activeSession, clearUnread, closeViewerTab, focusTerminal, getState, navOrder, rpc, setState, type NavTab, type State } from './store';
import { quoteSelection } from './quote';
import { terminals } from './TerminalView';
import { DEFAULT_FONT_SIZE } from './theme';
import { applyAppearance, currentTheme, missingFonts, monoFamily, xtermThemeFor } from './appearance';
import type { ThinkingDensity } from '../../shared/themes';

/**
 * Switch theme and/or fonts: CSS tokens, every open terminal, code highlighting, and main's View menu and
 * macOS chrome. Omitted parts keep their current value.
 */
export function setAppearance(p: { theme?: string; uiFont?: string; monoFont?: string } = {}): void {
  const st = getState();
  const next = applyAppearance(p.theme ?? st.themeId, p.uiFont ?? st.uiFontId, p.monoFont ?? st.monoFontId);
  setState({ themeId: next.theme, uiFontId: next.uiFont, monoFontId: next.monoFont, appearanceVersion: st.appearanceVersion + 1 });
  const family = monoFamily();
  const restyle = () => {
    for (const t of terminals.values()) {
      t.term.options.theme = xtermThemeFor(currentTheme());
      t.term.options.fontFamily = family;
      t.fit();
    }
  };
  restyle();
  // Bundled fonts load on first use; measure the terminal again once the new one has arrived.
  void document.fonts.load(`13px ${family.split(',')[0]}`).then(restyle).catch(() => {});
  window.jarvis.setAppearance({ ...next, density: getState().richDensity, missingFonts: missingFonts() });
}

/** Rich view thinking: Focus hides it, Normal folds each stretch, Detailed expands it all. */
export function setDensity(d: ThinkingDensity | 'next'): void {
  const order: ThinkingDensity[] = ['focus', 'normal', 'detailed'];
  const st = getState();
  const next = d === 'next' ? order[(order.indexOf(st.richDensity) + 1) % order.length]! : d;
  setState({ richDensity: next });
  window.jarvis.setAppearance({ theme: st.themeId, uiFont: st.uiFontId, monoFont: st.monoFontId, density: next, missingFonts: missingFonts() });
}

const SHELLS = /^(zsh|bash|fish|sh|-zsh|-bash)$/;

export function activate(id: string): void {
  setState({ activeId: id, dialog: null });
  clearUnread(id);
  focusTerminal();
}

/** ⇧⌘U: sessions blocked on you first (longest waiting), then finished turns you haven't seen. */
function nextAttention(): void {
  const st = getState();
  const all = st.snapshot?.sessions ?? [];
  const cur = activeSession(st)?.id;
  const blocked = all.filter((s) => s.agentState?.phase === 'needs_input' && s.id !== cur)
    .sort((a, b) => (a.agentState!.since) - (b.agentState!.since));
  const unread = all.filter((s) => st.unread[s.id] && s.id !== cur);
  const target = blocked[0] ?? unread[0];
  if (target) activate(target.id);
}

function step(delta: number): void {
  const s = getState();
  const list = navOrder(s);
  if (!list.length) return;
  const cur = list.findIndex((x) => x.id === activeSession(s)?.id);
  const next = list[(cur + delta + list.length) % list.length];
  if (next) activate(next.id);
}

export async function hideSession(sess: SessionInfo): Promise<void> {
  if (sess.external) return;
  const s = getState();
  const list = navOrder(s);
  const i = list.findIndex((x) => x.id === sess.id);
  await rpc('sessions.setHidden', { id: sess.id, hidden: !sess.hidden });
  if (!sess.hidden && !s.showHidden && s.activeId === sess.id) {
    const next = list[i + 1] ?? list[i - 1];
    setState({ activeId: next && next.id !== sess.id ? next.id : null });
  }
}

export async function endSession(sess: SessionInfo): Promise<void> {
  if (sess.external) return;
  const ok = await window.jarvis.confirm(
    `End "${sess.name}"?`,
    sess.agent === 'claude'
      ? 'The tmux session and Claude process stop. The conversation transcript stays on disk and can be resumed with claude --resume.'
      : 'The tmux session and everything running in it stop. The agent keeps its own session history.',
    'End Session',
  );
  if (!ok) return;
  const list = navOrder(getState());
  const i = list.findIndex((x) => x.id === sess.id);
  await rpc('sessions.remove', { id: sess.id });
  const next = list[i + 1] ?? list[i - 1];
  if (getState().activeId === sess.id) setState({ activeId: next && next.id !== sess.id ? next.id : null });
  focusTerminal();
}

export async function newSessionHere(): Promise<void> {
  const cur = activeSession(getState());
  if (!cur || cur.external) {
    setState({ dialog: { kind: 'new' } });
    return;
  }
  const created = await rpc<SessionInfo>('sessions.create', { cwd: cur.cwd, agent: cur.agent, model: cur.model });
  activate(created.id);
}

export async function sessionContextMenu(sess: SessionInfo): Promise<void> {
  const ext = sess.external;
  const pick = await window.jarvis.contextMenu([
    { id: 'rename', label: 'Rename…', enabled: !ext },
    { id: 'hide', label: sess.hidden ? 'Unhide' : 'Hide (keeps running)', enabled: !ext },
    { id: 'up', label: 'Move Up', enabled: !ext },
    { id: 'down', label: 'Move Down', enabled: !ext },
    { type: 'separator' },
    ...(sess.status === 'exited'
      ? [{ id: 'revive', label: 'Revive' }]
      : [{ id: 'kill', label: 'Stop Process (keep in list)', enabled: !ext }]),
    { id: 'end', label: 'End Session…', enabled: !ext },
    { type: 'separator' },
    { id: 'copy-attach', label: 'Copy Attach Command' },
    ...(sess.agentSessionId ? [{ id: 'copy-agent-id', label: 'Copy Agent Session ID' }] : []),
    { id: 'reveal', label: 'Reveal in Finder' },
  ]);
  switch (pick) {
    case 'rename': return setState({ dialog: { kind: 'rename', id: sess.id } });
    case 'hide': return hideSession(sess);
    case 'up': await rpc('sessions.move', { id: sess.id, delta: -1 }); return;
    case 'down': await rpc('sessions.move', { id: sess.id, delta: 1 }); return;
    case 'revive': await rpc('sessions.revive', { id: sess.id }); return activate(sess.id);
    case 'kill': await rpc('sessions.kill', { id: sess.id }); return;
    case 'end': return endSession(sess);
    case 'copy-attach': return window.jarvis.copyText(`jarvis attach ${sess.id}`);
    case 'copy-agent-id': return window.jarvis.copyText(sess.agentSessionId ?? '');
    case 'reveal': return window.jarvis.revealPath(sess.currentPath || sess.cwd);
  }
}

function withActive(fn: (s: SessionInfo, st: State) => void | Promise<void>): void {
  const st = getState();
  const s = activeSession(st);
  if (s && s.status === 'running') void fn(s, st);
}

export function handleMenu(action: MenuAction, arg?: number | string): void {
  const st = getState();
  // While a dialog is open, only let the dialog-opening shortcuts through.
  if (st.dialog && !['new-session', 'quick-switch', 'quick-open', 'open-preview', 'goto-session-id'].includes(action)) return;
  switch (action) {
    case 'toggle-navigator': return setState((s) => ({ navOpen: !s.navOpen }));
    case 'nav-tab': return setState({ navOpen: true, navTab: arg as NavTab });
    case 'quick-open': return setState({ dialog: st.dialog?.kind === 'open-file' ? null : { kind: 'open-file' } });
    case 'set-theme': return setAppearance({ theme: String(arg) });
    case 'set-ui-font': return setAppearance({ uiFont: String(arg) });
    case 'set-mono-font': return setAppearance({ monoFont: String(arg) });
    case 'set-density': return setDensity(String(arg) as ThinkingDensity);
    case 'cycle-density': return setDensity('next');
    case 'open-preview': return setState({ dialog: st.dialog?.kind === 'preview' ? null : { kind: 'preview' } });
    case 'toggle-viewer':
      if (!st.viewerTabs.length) return setState({ dialog: { kind: 'open-file' } });
      return setState((s) => ({ viewerOpen: !s.viewerOpen }));
    case 'close-viewer-tab': return closeViewerTab(st.viewerActive);
    case 'next-attention': return nextAttention();
    case 'goto-session-id': if (typeof arg === 'string') activate(arg); return;
    case 'quote-reply': { const s = activeSession(st); if (s && s.status === 'running') void quoteSelection(s); return; }
    case 'new-session': return setState({ dialog: { kind: 'new' } });
    case 'new-session-here': return void newSessionHere();
    case 'quick-switch': return setState({ dialog: st.dialog?.kind === 'switch' ? null : { kind: 'switch' } });
    case 'rename-session': {
      const s = activeSession(st);
      if (s && !s.external) setState({ dialog: { kind: 'rename', id: s.id } });
      return;
    }
    case 'hide-session': { const s = activeSession(st); if (s) void hideSession(s); return; }
    case 'end-session': { const s = activeSession(st); if (s) void endSession(s); return; }
    case 'next-session': return step(1);
    case 'prev-session': return step(-1);
    case 'goto-session': {
      const list = navOrder(st);
      const target = arg === -1 ? list[list.length - 1] : list[typeof arg === 'number' ? arg : 0];
      if (target) activate(target.id);
      return;
    }
    case 'move-up': return withActive((s) => void rpc('sessions.move', { id: s.id, delta: -1 }));
    case 'move-down': return withActive((s) => void rpc('sessions.move', { id: s.id, delta: 1 }));
    case 'split-right': return withActive((s) => void rpc('tmux.split', { id: s.id, direction: 'horizontal' }));
    case 'split-down': return withActive((s) => void rpc('tmux.split', { id: s.id, direction: 'vertical' }));
    case 'zoom-pane': return withActive((s) => void rpc('tmux.zoom', { id: s.id }));
    case 'pane-left': return withActive((s) => void rpc('tmux.selectPane', { id: s.id, direction: 'left' }));
    case 'pane-right': return withActive((s) => void rpc('tmux.selectPane', { id: s.id, direction: 'right' }));
    case 'pane-up': return withActive((s) => void rpc('tmux.selectPane', { id: s.id, direction: 'up' }));
    case 'pane-down': return withActive((s) => void rpc('tmux.selectPane', { id: s.id, direction: 'down' }));
    case 'find': return withActive((s) => void rpc('tmux.search', { id: s.id }));
    case 'copy-mode': return withActive((s) => void rpc('tmux.copyMode', { id: s.id }));
    case 'clear': return withActive(async (s) => {
      await rpc('tmux.clearHistory', { id: s.id });
      const t = terminals.get(s.id);
      t?.term.clear();
      if (s.paneCommand && SHELLS.test(s.paneCommand)) t?.write('\x0c');
    });
    case 'font-bigger': return setState((s) => ({ fontSize: Math.min(28, s.fontSize + 1) }));
    case 'font-smaller': return setState((s) => ({ fontSize: Math.max(8, s.fontSize - 1) }));
    case 'font-reset': return setState({ fontSize: DEFAULT_FONT_SIZE });
    // ⌘B collapses the sidebar to a rail of session icons and back (a hidden sidebar comes back as the full one).
    case 'toggle-sidebar': return setState((s) => (s.sidebar ? { sidebarRail: !s.sidebarRail } : { sidebar: true, sidebarRail: false }));
    case 'toggle-hidden': return setState((s) => ({ showHidden: !s.showHidden }));
  }
}
