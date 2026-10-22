import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { findTranscript } from './thinking';

interface Tracked {
  path: string;
  offset: number;
  custom: string | null;
  ai: string | null;
  checkedAt: number;
  pending: boolean;
}

/**
 * The title Claude gives a conversation: the name from /rename (`custom-title`) if there is one, else the
 * generated one (`ai-title`). Transcripts reach 100 MB, so each is read once and then only the bytes appended
 * since, and only lines that can carry a title are parsed.
 */
export class TitleTracker {
  private tracked = new Map<string, Tracked>();
  constructor(private claudeHome?: string, private recheckMs = 4000) {}

  /**
   * The latest known title for a Claude session (null until it has one). Refreshes in the background.
   * `ignore` drops a /rename'd title that is only Jarvis's own placeholder (older sessions were launched with `-n <repo name>`).
   */
  get(agentSessionId: string | null, ignore?: (title: string) => boolean): string | null {
    if (!agentSessionId) return null;
    let t = this.tracked.get(agentSessionId);
    if (!t) {
      const path = findTranscript(agentSessionId, this.claudeHome);
      if (!path) return null;
      t = { path, offset: 0, custom: null, ai: null, checkedAt: 0, pending: false };
      this.tracked.set(agentSessionId, t);
    }
    if (!t.pending && Date.now() - t.checkedAt > this.recheckMs) {
      t.pending = true;
      void this.refresh(t).finally(() => {
        t!.pending = false;
        t!.checkedAt = Date.now();
      });
    }
    return (t.custom && !ignore?.(t.custom) ? t.custom : null) ?? t.ai;
  }

  forget(agentSessionId: string): void {
    this.tracked.delete(agentSessionId);
  }

  private async refresh(t: Tracked): Promise<void> {
    let size: number;
    try {
      size = statSync(t.path).size;
    } catch {
      return;
    }
    if (size < t.offset) Object.assign(t, { offset: 0, custom: null, ai: null });
    if (size === t.offset) return;
    const fd = openSync(t.path, 'r');
    try {
      const chunk = Buffer.alloc(1 << 20);
      let carry = '';
      let pos = t.offset;
      while (pos < size) {
        const n = readSync(fd, chunk, 0, chunk.length, pos);
        if (n <= 0) break;
        pos += n;
        const text = carry + chunk.toString('utf8', 0, n);
        const lines = text.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) this.scan(t, line);
        // Yield so a 100 MB first read never holds the daemon's event loop.
        await new Promise((r) => setImmediate(r));
      }
      // A trailing line without a newline is still being written: read it again next time.
      t.offset = pos - Buffer.byteLength(carry);
    } finally {
      closeSync(fd);
    }
  }

  private scan(t: Tracked, line: string): void {
    const ai = line.startsWith('{"type":"ai-title"');
    if (!ai && !line.startsWith('{"type":"custom-title"')) return;
    try {
      const j = JSON.parse(line);
      const v = String(ai ? j.aiTitle : j.customTitle).trim();
      if (!v) return;
      if (ai) t.ai = v;
      else t.custom = v;
    } catch { /* partial or foreign line */ }
  }
}
