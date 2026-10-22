import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export interface Prefs {
  /** A sound when an agent finishes. */
  soundDone: boolean;
  /** A sound when an agent needs you (a question, a permission). */
  soundNeeds: boolean;
  /** Skip the sound when you are already looking at that session. */
  soundOnlyWhenAway: boolean;
  /** A desktop notification when you are not looking at it. */
  notify: boolean;
}

export const DEFAULT_PREFS: Prefs = { soundDone: true, soundNeeds: true, soundOnlyWhenAway: false, notify: true };

const file = () => join(app.getPath('userData'), 'prefs.json');

export function loadPrefs(): Prefs {
  try {
    if (existsSync(file())) return { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch { /* unreadable: defaults */ }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(p: Prefs): void {
  try {
    writeFileSync(file(), JSON.stringify(p, null, 2));
  } catch { /* read-only data folder: the choice lasts until quit */ }
}
