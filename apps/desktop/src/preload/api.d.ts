import type { JarvisApi, DaemonStatus } from '../shared/ipc';
import type { Snapshot } from '@jarvis/protocol';

declare global {
  interface Window {
    jarvis: JarvisApi & { initialState(): Promise<{ snapshot: Snapshot | null; status: DaemonStatus }> };
  }
}
export {};
