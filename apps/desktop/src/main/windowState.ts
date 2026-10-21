import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = () => join(app.getPath('userData'), 'window-state.json');

export function loadBounds(): Partial<Rectangle> {
  try {
    if (!existsSync(file())) return { width: 1400, height: 900 };
    const b = JSON.parse(readFileSync(file(), 'utf8')) as Rectangle;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    return visible ? b : { width: b.width, height: b.height };
  } catch {
    return { width: 1400, height: 900 };
  }
}

export function trackBounds(win: BrowserWindow): void {
  let t: NodeJS.Timeout | null = null;
  const save = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      if (win.isDestroyed() || win.isFullScreen()) return;
      try {
        writeFileSync(file(), JSON.stringify(win.getNormalBounds()));
      } catch { /* ignore */ }
    }, 400);
  };
  win.on('resize', save);
  win.on('move', save);
}

/** Cmd+Enter: toggle between the current size and filling the screen's work area (WezTerm behaviour). */
export function toggleMaximize(win: BrowserWindow, saved: Map<number, Rectangle>): void {
  const prev = saved.get(win.id);
  if (prev) {
    win.setBounds(prev, true);
    saved.delete(win.id);
    return;
  }
  saved.set(win.id, win.getBounds());
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  win.setBounds(area, true);
}
