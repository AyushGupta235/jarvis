import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { JarvisApi } from '../shared/ipc';

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const h = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const api: JarvisApi & { initialState(): Promise<unknown> } = {
  rpc: (method, params) => ipcRenderer.invoke('rpc', method, params),
  initialState: () => ipcRenderer.invoke('daemon:state'),
  onSnapshot: (cb) => on('snapshot', cb),
  onDaemonStatus: (cb) => on('daemon:status', cb),
  onMenu: (cb) => on('menu', cb),
  onActivity: (cb) => on('activity', cb),
  onFilesChanged: (cb) => on('files.changed', cb),
  onAttention: (cb) => on('attention', cb),
  onRichEvent: (cb) => on('rich.event', cb),
  setUiState: (activeId, badge) => ipcRenderer.send('ui:state', activeId, badge),
  ptyOpen: (sessionId, cols, rows) => ipcRenderer.invoke('pty:open', sessionId, cols, rows),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyClose: (id) => ipcRenderer.send('pty:close', id),
  onPtyData: (cb) => on('pty:data', cb),
  onPtyExit: (cb) => on('pty:exit', cb),
  chooseDirectory: (p) => ipcRenderer.invoke('dialog:chooseDirectory', p),
  confirm: (m, d, ok) => ipcRenderer.invoke('dialog:confirm', m, d, ok),
  contextMenu: (items) => ipcRenderer.invoke('contextMenu', items),
  openExternal: (url) => ipcRenderer.send('openExternal', url),
  revealPath: (p) => ipcRenderer.send('revealPath', p),
  copyText: (t) => ipcRenderer.send('copyText', t),
  homeDir: process.env.HOME ?? '',
};

contextBridge.exposeInMainWorld('jarvis', api);
