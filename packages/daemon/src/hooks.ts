import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HookSource {
  file: string;
  hooks: { event: string; matcher: string; command: string }[];
}

/**
 * The hooks Claude Code will run for a directory, from the settings files it reads (user, project, local).
 * Hooks that plugins register are not in these files, so they are not listed here.
 */
export function readHooks(cwd: string, home = homedir()): HookSource[] {
  const files = [join(home, '.claude/settings.json'), join(cwd, '.claude/settings.json'), join(cwd, '.claude/settings.local.json')];
  const out: HookSource[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let json: any;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const hooks: HookSource['hooks'] = [];
    for (const [event, groups] of Object.entries<any>(json?.hooks ?? {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          hooks.push({ event, matcher: String(g?.matcher ?? '*'), command: String(h?.command ?? h?.prompt ?? h?.url ?? h?.type ?? '') });
        }
      }
    }
    if (hooks.length) out.push({ file: file.replace(home, '~'), hooks });
  }
  return out;
}
