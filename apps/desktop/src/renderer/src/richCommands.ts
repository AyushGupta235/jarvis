import { NATIVE_RICH_COMMANDS, SCREEN_ONLY_COMMANDS, type RichInfo } from '@jarvis/protocol';

/**
 * Every slash command a rich session understands, and how it runs:
 * - sdk: sent as the prompt; Claude Code runs it (built-ins, custom commands, skills).
 * - jarvis: the rich view does it itself (/resume, /permissions, /copy...).
 * - terminal: needs Claude Code's own screen; the conversation reopens there with the command typed.
 */
export type CommandKind = 'sdk' | 'jarvis' | 'terminal';

export interface Command {
  name: string;
  hint: string;
  description: string;
  kind: CommandKind;
}

/** What the screen-only commands do, for the palette (Claude Code doesn't describe them over the SDK). */
const SCREEN_ONLY_DESC: Record<string, string> = {
  'add-dir': 'Add a working directory', bashes: 'List background shells', color: 'Set the prompt bar color',
  doctor: 'Check the Claude Code installation', fast: 'Toggle fast mode (not available through the SDK)',
  feedback: 'Send feedback to Anthropic', focus: 'Toggle focus view', hooks: 'Manage hooks', ide: 'Connect to an IDE',
  'install-github-app': 'Set up the Claude GitHub app', keybindings: 'Edit keybindings', login: 'Sign in', logout: 'Sign out',
  plugin: 'Manage plugins', 'privacy-settings': 'Privacy settings', 'release-notes': 'Release notes',
  'reload-plugins': 'Activate pending plugin changes', rewind: 'Rewind the conversation and files', sandbox: 'Sandbox settings',
  statusline: 'Set up the status line', tasks: 'List background tasks', 'terminal-setup': 'Set up terminal key bindings',
  theme: 'Change the theme', todos: 'Show the todo list', upgrade: 'Upgrade your plan', vim: 'Toggle vim mode',
};

/** Typed without an argument, these open a picker instead of printing usage. */
export const PICKER_COMMANDS = new Set(['model', 'effort', 'output-style']);

export function commandCatalog(info: RichInfo | null): Command[] {
  const all = new Map<string, Command>();
  for (const c of info?.commands ?? []) {
    all.set(c.name, { name: c.name, hint: c.argumentHint, description: c.description, kind: 'sdk' });
  }
  for (const [name, description] of Object.entries(NATIVE_RICH_COMMANDS)) {
    all.set(name, { name, hint: name === 'resume' ? '[conversation]' : '', description, kind: 'jarvis' });
  }
  for (const name of new Set([...SCREEN_ONLY_COMMANDS, ...(info?.terminalCommands ?? [])])) {
    if (all.get(name)?.kind === 'jarvis') continue;
    all.set(name, { name, hint: '', description: SCREEN_ONLY_DESC[name] ?? all.get(name)?.description ?? 'Runs in Claude Code', kind: 'terminal' });
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
