import type { RichInfo } from '@jarvis/protocol';

import { BUILTIN_COMMANDS, COMMAND_ALIASES, type Route } from './commandTable';

/**
 * Every slash command a rich session understands, and how it runs (commandTable.ts decides, per built-in):
 * - sdk: sent as the prompt; Claude Code runs it (the commands it supports, custom commands, skills).
 * - jarvis: the rich view does it itself (/plan, /btw, /mcp, /resume...).
 * - terminal: needs Claude Code's own screen; the conversation reopens there with the command typed.
 * - link: opens a web page. note: nothing to do here, and the reason is shown.
 */
export type CommandKind = Route['kind'];

export interface Command {
  name: string;
  hint: string;
  description: string;
  kind: CommandKind;
  route: Route;
}

/** Typed without an argument, these open a picker instead of printing usage. */
export const PICKER_COMMANDS = new Set(['model', 'effort', 'output-style']);

/** The command an alias means ("/quit" is "/exit"); other names are themselves. */
export function canonicalName(name: string): string {
  return COMMAND_ALIASES.get(name) ?? name;
}

export function commandCatalog(info: RichInfo | null): Command[] {
  const all = new Map<string, Command>();
  // What Claude Code reports: skills, your own commands, and the built-ins it can run itself.
  for (const c of info?.commands ?? []) {
    all.set(c.name, { name: c.name, hint: c.argumentHint, description: c.description, kind: 'sdk', route: { kind: 'sdk' } });
  }
  // Commands only its own screen can run, as it reports them.
  for (const name of info?.terminalCommands ?? []) {
    if (!all.has(name)) all.set(name, { name, hint: '', description: 'Runs in Claude Code', kind: 'terminal', route: { kind: 'terminal' } });
  }
  // The decision for each built-in wins over what the SDK does with the same name.
  for (const b of BUILTIN_COMMANDS) {
    const reported = all.get(b.name);
    const entry = { hint: b.hint ?? reported?.hint ?? '', description: reported?.description || b.description, kind: b.route.kind, route: b.route };
    all.set(b.name, { name: b.name, ...entry });
    for (const a of b.aliases ?? []) if (!all.has(a) || all.get(a)!.kind === 'terminal') all.set(a, { name: a, ...entry, description: `${b.description} (same as /${b.name})` });
  }
  return [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Palette matches: name prefix first, then name contains, then description contains. */
export function matchCommands(list: Command[], query: string): Command[] {
  const q = query.toLowerCase();
  if (!q) return list;
  const rank = (c: Command) => {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(/[:-]/).some((p) => p.startsWith(q))) return 1;
    if (n.includes(q)) return 2;
    if (c.description.toLowerCase().includes(q)) return 3;
    return 9;
  };
  return list.map((c) => [rank(c), c] as const).filter(([r]) => r < 9).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

/** `/name args` → parts, or null if the text isn't a slash command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([\w:.@-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : null;
}

export const PERMISSION_MODES: { value: string; label: string; detail: string }[] = [
  { value: 'default', label: 'Default', detail: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', detail: 'Edit files without asking, still ask for commands' },
  { value: 'plan', label: 'Plan', detail: 'Read and plan only, no changes' },
  { value: 'auto', label: 'Auto', detail: 'A classifier approves safe actions and asks about the rest' },
  { value: 'dontAsk', label: "Don't ask", detail: 'Deny anything not already allowed by your rules' },
  { value: 'bypassPermissions', label: 'Bypass', detail: 'Allow everything without asking. Use with care' },
];

export const EFFORT_LEVELS: { value: string; detail: string }[] = [
  { value: 'low', detail: 'Fastest, least thinking' }, { value: 'medium', detail: 'Balanced' },
  { value: 'high', detail: 'More thinking' }, { value: 'xhigh', detail: 'Even more' }, { value: 'max', detail: 'Most thinking, slowest' },
  { value: 'auto', detail: 'Let Claude Code choose' },
];
