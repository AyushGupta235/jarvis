import { useSyncExternalStore } from 'react';
import type { ActivityEntry, AgentDef, AgentKind, SessionInfo, SessionMode, Snapshot, WorkspaceInfo } from '@jarvis/protocol';
import { ACTIVE_WINDOW_MS } from '@jarvis/protocol';
import type { DaemonStatus } from '../../shared/ipc';
import { DEFAULT_FONT_SIZE } from './theme';

export type Dialog =
  | null
  | { kind: 'new'; repoPath?: string }
  | { kind: 'switch' }
  | { kind: 'rename'; id: string }
  | { kind: 'open-file' };

export type NavTab = 'activity' | 'files' | 'changes' | 'docs' | 'prs' | 'connectors' | 'usage';

export interface ViewerTab {
  /** Absolute path. */
  path: string;
  /** Repo root it was opened from (for diffs and relative labels). */
  root: string | null;
  mode: 'file' | 'diff';
  line?: number;
}

export interface State {
  snapshot: Snapshot | null;
  status: DaemonStatus;
  activeId: string | null;
  showHidden: boolean;
  sidebar: boolean;
  fontSize: number;
  dialog: Dialog;
  collapsed: Record<string, boolean>;
  lastAgent: AgentKind;
  lastModel: string | null;
  /** Terminal or rich, for agents that have both. */
  lastMode: SessionMode;
  error: string | null;
  navOpen: boolean;
  navTab: NavTab;
  navWidth: number;
  viewerOpen: boolean;
  viewerTabs: ViewerTab[];
  viewerActive: number;
  viewerWidth: number;
  /** Sessions that finished or need you while you were looking elsewhere. */
  unread: Record<string, 'done' | 'needs_input'>;
  activity: Record<string, ActivityEntry[]>;
}

const PREFS_KEY = 'jarvis.prefs.v1';
type Prefs = Pick<State, 'activeId' | 'showHidden' | 'sidebar' | 'fontSize' | 'collapsed' | 'lastAgent' | 'lastModel' | 'lastMode'
  | 'navOpen' | 'navTab' | 'navWidth' | 'viewerOpen' | 'viewerTabs' | 'viewerActive' | 'viewerWidth'>;

function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<Prefs>;
  } catch {
    return {};
  }
}

let state: State = {
  snapshot: null,
  status: { connected: false },
  activeId: null,
  showHidden: false,
  sidebar: true,
  fontSize: DEFAULT_FONT_SIZE,
  dialog: null,
  collapsed: {},
  lastAgent: 'claude',
  lastModel: null,
  lastMode: 'terminal',
  error: null,
  navOpen: true,
  navTab: 'activity',
  navWidth: 430,
  viewerOpen: false,
  viewerTabs: [],
  viewerActive: 0,
  viewerWidth: 560,
  unread: {},
  activity: {},
  ...loadPrefs(),
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  try {
    const prefs: Prefs = {
      activeId: state.activeId, showHidden: state.showHidden, sidebar: state.sidebar, fontSize: state.fontSize,
      collapsed: state.collapsed, lastAgent: state.lastAgent, lastModel: state.lastModel, lastMode: state.lastMode,
      navOpen: state.navOpen, navTab: state.navTab, navWidth: state.navWidth, viewerOpen: state.viewerOpen,
      viewerTabs: state.viewerTabs.slice(0, 20), viewerActive: state.viewerActive, viewerWidth: state.viewerWidth,
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* storage unavailable */ }
  for (const l of listeners) l();
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sel(state),
  );
}

export async function initStore(): Promise<void> {
  const init = await window.jarvis.initialState();
  setState({ snapshot: init.snapshot, status: init.status });
  window.jarvis.onSnapshot((snapshot) => {
    setState({ snapshot });
    syncUi();
  });
  window.jarvis.onDaemonStatus((status) => setState({ status }));
  window.jarvis.onActivity((e) => {
    const cur = state.activity[e.sessionId];
    if (!cur) return; // not loaded yet; the panel fetches the full list when opened
    const i = cur.findIndex((x) => x.id === e.id);
    const next = i >= 0 ? cur.map((x, j) => (j === i ? e : x)) : [...cur, e].slice(-800);
    setState({ activity: { ...state.activity, [e.sessionId]: next } });
  });
  window.jarvis.onAttention((a) => {
    const visible = document.hasFocus() && activeSession(state)?.id === a.sessionId;
    if (!visible) setState({ unread: { ...state.unread, [a.sessionId]: a.phase === 'needs_input' ? 'needs_input' : 'done' } });
    syncUi();
  });
  window.addEventListener('focus', () => clearUnread(activeSession(state)?.id ?? null));
  syncUi();
}

export async function loadActivity(id: string): Promise<void> {
  const list = await window.jarvis.rpc<ActivityEntry[]>('activity.list', { id, limit: 600 });
  setState({ activity: { ...state.activity, [id]: list } });
}

export function clearUnread(id: string | null): void {
  if (!id || !state.unread[id]) return;
  const { [id]: _drop, ...rest } = state.unread;
  setState({ unread: rest });
  syncUi();
}

/** Dock badge = sessions blocked on you + finished turns you haven't looked at. */
export function syncUi(): void {
  const blocked = (state.snapshot?.sessions ?? []).filter((s) => s.agentState?.phase === 'needs_input').map((s) => s.id);
  const ids = new Set([...blocked, ...Object.keys(state.unread)]);
  window.jarvis.setUiState(activeSession(state)?.id ?? null, ids.size);
}

/** Open a file (or its diff) in the viewer pane, reusing an existing tab. */
export function openInViewer(tab: ViewerTab): void {
  const tabs = state.viewerTabs;
  const i = tabs.findIndex((t) => t.path === tab.path && t.mode === tab.mode);
  if (i >= 0) {
    const updated = tabs.map((t, j) => (j === i ? { ...t, line: tab.line } : t));
    setState({ viewerOpen: true, viewerTabs: updated, viewerActive: i });
  } else {
    setState({ viewerOpen: true, viewerTabs: [...tabs, tab].slice(-12), viewerActive: Math.min(tabs.length, 11) });
  }
}

export function closeViewerTab(i: number): void {
  const tabs = state.viewerTabs.filter((_, j) => j !== i);
  setState({ viewerTabs: tabs, viewerActive: Math.max(0, Math.min(state.viewerActive, tabs.length - 1)), viewerOpen: tabs.length > 0 && state.viewerOpen });
}

/** Repo root to browse for a session: its worktree if it runs in one, else its repo. */
export function sessionRoot(s: SessionInfo | null): string | null {
  if (!s || s.external) return s?.currentPath ?? null;
  return s.worktree ?? s.repoRoot;
}

export function flashError(msg: string): void {
  setState({ error: msg });
  setTimeout(() => {
    if (getState().error === msg) setState({ error: null });
  }, 6000);
}

export async function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  try {
    return await window.jarvis.rpc<T>(method, params);
  } catch (e) {
    flashError(String((e as Error).message).replace(/^Error invoking remote method 'rpc': (Error: )?/, ''));
    throw e;
  }
}

export interface Group {
  ws: WorkspaceInfo;
  sessions: SessionInfo[];
}

/** Workspaces in creation order (external tmux last), sessions in their saved order. */
export function groups(snap: Snapshot | null, showHidden: boolean): Group[] {
  if (!snap) return [];
  const byRoot = new Map<string, SessionInfo[]>();
  for (const s of [...snap.sessions].sort((a, b) => a.order - b.order)) {
    if (s.hidden && !showHidden) continue;
    const arr = byRoot.get(s.repoRoot) ?? [];
    arr.push(s);
    byRoot.set(s.repoRoot, arr);
  }
  const out: Group[] = [];
  for (const ws of snap.workspaces) {
    const sessions = byRoot.get(ws.root);
    if (sessions?.length) out.push({ ws, sessions });
  }
  out.sort((a, b) => {
    const ea = a.ws.root === 'tmux:default' ? 1 : 0;
    const eb = b.ws.root === 'tmux:default' ? 1 : 0;
    return ea - eb || Math.min(...a.sessions.map((s) => s.order)) - Math.min(...b.sessions.map((s) => s.order));
  });
  return out;
}

/** Flat list in sidebar order; ⌘1..9 index into this. Collapsed groups are skipped. */
export function navOrder(s: State): SessionInfo[] {
  return groups(s.snapshot, s.showHidden)
    .filter((g) => !s.collapsed[g.ws.root])
    .flatMap((g) => g.sessions);
}

export function activeSession(s: State): SessionInfo | null {
  const all = s.snapshot?.sessions ?? [];
  return all.find((x) => x.id === s.activeId) ?? navOrder(s)[0] ?? null;
}

export function agentDef(s: State, id: string): AgentDef | undefined {
  return s.snapshot?.agents.find((a) => a.id === id);
}

export type Activity = 'working' | 'needs_input' | 'done' | 'idle' | 'exited';

/** What the sidebar dot shows: agent state from observers when available, else tmux activity. */
export function activity(s: SessionInfo, now: number): Activity {
  if (s.status === 'exited') return 'exited';
  const a = s.agentState;
  if (a) {
    if (a.phase === 'needs_input') return 'needs_input';
    if (a.phase === 'working' || a.phase === 'compacting') return 'working';
    if (a.phase === 'done') return 'done';
    return 'idle';
  }
  return s.lastActivity && now - s.lastActivity < ACTIVE_WINDOW_MS ? 'working' : 'idle';
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '–';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '–';
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(n >= 10 ? 1 : 2)}`;
}

export function until(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '';
  const m = Math.max(0, Math.round((ms - now) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.round(m / 1440)}d`;
}

export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function tildify(p: string | null | undefined): string {
  if (!p) return '';
  const home = getState().snapshot?.daemon.home.replace(/\/\.jarvis$/, '') || window.jarvis.homeDir;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function focusTerminal(): void {
  window.dispatchEvent(new Event('jarvis:focus-terminal'));
}
