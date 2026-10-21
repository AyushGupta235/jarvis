/** IPC contract between the Electron main process and the renderer. */
import type { ActivityEntry, AgentPhase, Snapshot } from '@jarvis/protocol';

export type MenuAction =
  | 'new-session' | 'new-session-here' | 'hide-session' | 'end-session' | 'rename-session'
  | 'quick-switch' | 'next-session' | 'prev-session' | 'goto-session'
  | 'split-right' | 'split-down' | 'zoom-pane' | 'pane-left' | 'pane-right' | 'pane-up' | 'pane-down'
  | 'clear' | 'find' | 'font-bigger' | 'font-smaller' | 'font-reset' | 'toggle-sidebar' | 'toggle-hidden'
  | 'move-up' | 'move-down' | 'copy-mode'
  | 'toggle-navigator' | 'nav-tab' | 'quick-open' | 'toggle-viewer' | 'close-viewer-tab' | 'next-attention' | 'quote-reply'
  | 'goto-session-id';

export interface ContextMenuItem {
  id?: string;
  label?: string;
  type?: 'separator';
  enabled?: boolean;
}

export interface DaemonStatus {
  connected: boolean;
  error?: string;
}

export interface AttentionEvent {
  sessionId: string;
  phase: AgentPhase;
  message: string | null;
}

export interface JarvisApi {
  onActivity(cb: (e: ActivityEntry) => void): () => void;
  onFilesChanged(cb: (d: { root: string; paths: string[] }) => void): () => void;
  onAttention(cb: (a: AttentionEvent) => void): () => void;
  /** Tell main which session is on screen and how many need you (dock badge). */
  setUiState(activeId: string | null, badge: number): void;
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  onDaemonStatus(cb: (s: DaemonStatus) => void): () => void;
  onMenu(cb: (action: MenuAction, arg?: number | string) => void): () => void;
  ptyOpen(sessionId: string, cols: number, rows: number): Promise<number>;
  ptyWrite(ptyId: number, data: string): void;
  ptyResize(ptyId: number, cols: number, rows: number): void;
  ptyClose(ptyId: number): void;
  onPtyData(cb: (ptyId: number, data: string) => void): () => void;
  onPtyExit(cb: (ptyId: number, code: number) => void): () => void;
  chooseDirectory(defaultPath?: string): Promise<string | null>;
  confirm(message: string, detail: string, okLabel: string): Promise<boolean>;
  contextMenu(items: ContextMenuItem[]): Promise<string | null>;
  openExternal(url: string): void;
  revealPath(path: string): void;
  copyText(text: string): void;
  homeDir: string;
}
