import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { synthesize, type SoundKind } from './synth';

/** The sound as a file (written once, in the app's data folder). */
export function soundFile(kind: SoundKind): string {
  const dir = join(app.getPath('userData'), 'sounds');
  const file = join(dir, `${kind}-v1.wav`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, synthesize(kind));
  }
  return file;
}

const lastPlayed: Partial<Record<SoundKind, number>> = {};

/** Play it through macOS. Several agents finishing together sound once. JARVIS_SOUND_LOG makes tests write instead of play. */
export function playSound(kind: SoundKind): void {
  const now = Date.now();
  if (now - (lastPlayed[kind] ?? 0) < 1200) return;
  lastPlayed[kind] = now;
  const file = soundFile(kind);
  if (process.env.JARVIS_SOUND_LOG) {
    appendFileSync(process.env.JARVIS_SOUND_LOG, `${kind}\n`);
    return;
  }
  execFile('afplay', ['-v', '0.7', file], () => { /* no sound device: nothing to do */ });
}
