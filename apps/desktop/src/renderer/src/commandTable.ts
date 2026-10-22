/**
 * Every built-in Claude Code slash command (from its command reference) and how the rich view runs it. The SDK
 * only runs some of them when they arrive as a prompt (the rest answer "isn't available in this environment"),
 * so each one needs a decision:
 *
 * - jarvis: the rich view (or its host) does it itself, with the SDK's own API where there is one.
 * - sdk: sent as the prompt; Claude Code runs it.
 * - terminal: needs Claude Code's own screen; the conversation reopens in a terminal with the command typed.
 * - link: opens a web page.
 * - note: nothing to do in this view; says why.
 */
export type Route =
  | { kind: 'jarvis' }
  | { kind: 'sdk' }
  | { kind: 'terminal' }
  | { kind: 'link'; url: string }
  | { kind: 'note'; text: string };

export interface BuiltinCommand {
  name: string;
  hint?: string;
  description: string;
  route: Route;
  /** Other names that run the same command. */
  aliases?: string[];
}

const J: Route = { kind: 'jarvis' };
const S: Route = { kind: 'sdk' };
const T: Route = { kind: 'terminal' };
const note = (text: string): Route => ({ kind: 'note', text });
const link = (url: string): Route => ({ kind: 'link', url });

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  // Done by the rich view
  { name: 'plan', hint: '[description]', description: 'Enter plan mode, optionally starting on a task', route: J },
  { name: 'btw', hint: '<question>', description: 'Ask a side question without adding to the conversation', route: J },
  { name: 'add-dir', hint: '<path>', description: 'Let Claude work in another directory', route: J },
  { name: 'cd', hint: '<path>', description: 'Move this session to another directory, keeping the conversation', route: J },
  { name: 'branch', hint: '[name]', description: 'Fork the conversation here and continue in the fork', route: J },
  { name: 'fork', hint: '[prompt]', description: 'Copy the conversation into a new session and stay here', route: J },
  { name: 'subtask', hint: '<task>', description: 'Hand a task to a background subagent that knows the conversation', route: J },
  { name: 'diff', description: 'Review the changes in your working tree', route: J },
  { name: 'tasks', description: 'Background commands and subagents: view and stop', route: J, aliases: ['bashes'] },
  { name: 'mcp', hint: '[reconnect|enable|disable <server>]', description: 'MCP servers: status, reconnect, enable and disable', route: J },
  { name: 'hooks', description: 'View the hooks configured for this directory', route: J },
  { name: 'agents', description: 'List the subagents Claude can use', route: J },
  { name: 'skills', description: 'List available skills and commands', route: J },
  { name: 'rename', hint: '[name]', description: 'Rename the session (no name: follow Claude\'s title again)', route: J },
  { name: 'color', hint: '[color|default]', description: 'Set this session\'s accent color', route: J },
  { name: 'theme', description: 'Change the color theme', route: J },
  { name: 'focus', description: 'Show only the conversation, with thinking hidden', route: J },
  { name: 'keybindings', description: 'Open your keyboard shortcuts file', route: J },
  { name: 'resume', hint: '[conversation]', description: 'Resume a conversation from this directory', route: J, aliases: ['continue'] },
  { name: 'rewind', description: 'Go back to before one of your prompts', route: J, aliases: ['checkpoint', 'undo'] },
  { name: 'context', description: 'See what is using the context window', route: J },
  { name: 'permissions', description: 'Choose the permission mode', route: J },
  { name: 'status', description: 'Version, model, account and connectivity', route: J },
  { name: 'copy', hint: '[N]', description: "Copy Claude's last reply", route: J },
  { name: 'export', hint: '[filename]', description: 'Export the conversation as markdown', route: J },
  { name: 'memory', description: 'Edit CLAUDE.md files', route: J },
  { name: 'help', description: 'Show the commands you can use', route: J },
  { name: 'exit', description: 'End this session', route: J, aliases: ['quit'] },
  { name: 'stop', description: 'Stop the current turn', route: J },
  { name: 'background', hint: '[prompt]', description: 'Jarvis sessions already run in the background', route: note('Jarvis sessions already keep running in the background, even with the app closed. Close the tab or switch away; the session carries on and shows up in the sidebar.') },

  // Claude Code runs these when they are sent as the prompt
  { name: 'clear', hint: '[name]', description: 'Start a new conversation with empty context', route: S },
  { name: 'compact', hint: '[instructions]', description: 'Summarize the conversation to free context', route: S },
  { name: 'model', hint: '[model]', description: 'Switch the model', route: S },
  { name: 'effort', hint: '[level|auto|status]', description: 'Set the effort level', route: S },
  { name: 'output-style', hint: '[style]', description: 'List or switch output styles', route: S },
  { name: 'init', description: 'Create a CLAUDE.md for this project', route: S },
  { name: 'usage', description: 'Session cost, plan limits and activity', route: S, aliases: ['cost', 'stats'] },
  { name: 'config', hint: '[key=value ...]', description: 'Change settings (key=value)', route: S },
  { name: 'advisor', hint: '[model|off]', description: 'Turn the advisor model on or off', route: S },
  { name: 'autocompact', hint: '[auto|<tokens>]', description: 'Set the auto-compact window', route: S },
  { name: 'recap', description: 'One-line summary of the session', route: S },
  { name: 'goal', hint: '[condition|clear]', description: 'Keep working across turns until a condition is met', route: S },
  { name: 'insights', description: 'Report on how you use Claude Code', route: S },
  { name: 'list-agents', description: 'Sessions and subagents Claude can message', route: S },
  { name: 'skill-doctor', description: 'What your skills cost in context', route: S },
  { name: 'reload-plugins', hint: '[--force]', description: 'Apply plugin changes without restarting', route: S },
  { name: 'reload-skills', description: 'Re-scan skills and commands on disk', route: S },
  { name: 'import', hint: '[codex|gemini|cursor]', description: 'Bring in settings from another tool', route: S },
  { name: 'heapdump', description: 'Write a memory snapshot to ~/Desktop', route: S },
  { name: 'team-onboarding', description: 'Generate a team onboarding guide', route: S },
  { name: 'auto-mode-setup', description: 'Draft auto-mode environment rules', route: S },
  { name: 'usage-credits', description: 'Usage credits settings', route: S },
  { name: 'extra-usage', description: 'Extra usage settings', route: S },
  { name: 'doctor', description: 'Check the Claude Code setup', route: S },
  { name: 'code-review', hint: '[level] [--fix] [--comment] [pr#|branch|path]', description: 'Review the current diff or a PR for correctness bugs', route: S, aliases: ['review'] },

  // Pages
  { name: 'release-notes', description: 'Read the changelog', route: link('https://code.claude.com/docs/en/changelog') },
  { name: 'upgrade', description: 'Upgrade your plan', route: link('https://claude.ai/upgrade') },
  { name: 'privacy-settings', description: 'Privacy settings', route: link('https://claude.ai/settings/data-privacy-controls') },

  // Not for this view
  { name: 'vim', description: 'Removed in Claude Code; the rich composer is a plain text box', route: note('/vim was removed from Claude Code.') },
  { name: 'ultraplan', hint: '<prompt>', description: 'Removed; use /plan', route: note('/ultraplan was removed from Claude Code. Use /plan.') },
  { name: 'pr-comments', hint: '[PR]', description: 'Removed; ask Claude about the PR', route: note('/pr-comments was removed from Claude Code. Ask Claude to read the pull request comments.') },
  { name: 'statusline', description: 'Jarvis shows model, context and cost in the title bar', route: note("The rich view has no status line: the title bar already shows the model, context % and state, and the sidebar shows cost.") },
  { name: 'tui', hint: '[default|fullscreen]', description: 'Terminal renderer setting', route: note('/tui is a terminal rendering setting; the rich view does not use the terminal renderer.') },
  { name: 'scroll-speed', description: 'Terminal scroll speed', route: note('/scroll-speed is a terminal setting; scrolling here is the normal page scroll.') },
  { name: 'terminal-setup', description: 'Terminal key bindings', route: note('/terminal-setup configures a terminal; the rich composer already sends on Enter and adds a newline on Shift+Enter.') },

  // Claude Code's own screens
  { name: 'login', description: 'Sign in to your Anthropic account', route: T },
  { name: 'logout', description: 'Sign out', route: T },
  { name: 'plugin', hint: '[subcommand]', description: 'Manage plugins', route: T },
  { name: 'bug', hint: '[report]', description: 'Report a bug (asks what to include)', route: T },
  { name: 'feedback', hint: '[report]', description: 'Send feedback (asks what to include)', route: T },
  { name: 'ide', description: 'Manage IDE integrations', route: T },
  { name: 'chrome', description: 'Claude in Chrome settings', route: T },
  { name: 'desktop', description: 'Continue in the Claude desktop app', route: T, aliases: ['app'] },
  { name: 'mobile', description: 'QR code for the Claude mobile app', route: T, aliases: ['ios', 'android'] },
  { name: 'install-github-app', description: 'Install the Claude GitHub app', route: T },
  { name: 'install-slack-app', description: 'Install the Claude Slack app', route: T },
  { name: 'setup-bedrock', description: 'Configure Amazon Bedrock', route: T },
  { name: 'setup-vertex', description: 'Configure Google Cloud', route: T },
  { name: 'remote-control', description: 'Make this session available to claude.ai', route: T },
  { name: 'remote-env', description: 'Default cloud environment', route: T },
  { name: 'teleport', description: 'Pull a cloud session into this terminal', route: T, aliases: ['tp'] },
  { name: 'web-setup', description: 'Connect GitHub for cloud sessions', route: T },
  { name: 'autofix-pr', hint: '[prompt]', description: 'Cloud session that fixes CI and review comments', route: T },
  { name: 'ultrareview', hint: '[PR or branch]', description: 'Deep multi-agent review in a cloud sandbox', route: T },
  { name: 'workflows', description: 'Watch, pause and resume workflows', route: T },
  { name: 'sandbox', description: 'Toggle sandbox mode', route: T },
  { name: 'voice', hint: '[hold|tap|off]', description: 'Voice dictation', route: T },
  { name: 'rate-limit-options', description: 'Options when a usage limit blocks a request', route: T },
  { name: 'artifacts', description: 'Your artifacts', route: T },
  { name: 'design-login', description: 'Authorize design-system access', route: T },
  { name: 'powerup', description: 'Interactive feature lessons', route: T },
  { name: 'passes', description: 'Share a free week of Claude Code', route: T },
  { name: 'stickers', description: 'Order Claude Code stickers', route: T },
  { name: 'radio', description: 'Claude FM lo-fi radio', route: T },
];

/** name or alias → the command it means. */
export const COMMAND_ALIASES: Map<string, string> = new Map(
  BUILTIN_COMMANDS.flatMap((c) => (c.aliases ?? []).map((a) => [a, c.name] as const)),
);
