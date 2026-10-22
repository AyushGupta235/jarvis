/**
 * Shared types and constants for jarvisd (daemon), the `jarvis` CLI and the desktop app.
 * Everything that crosses the daemon socket is defined here. Browser-safe: no Node imports.
 */

export const PROTOCOL_VERSION = 1;
/** Agent id from the registry: 'shell', a built-in ('claude', 'codex', 'pi', …) or one from ~/.jarvis/agents.json. */
export type AgentKind = string;

/**
 * How Jarvis launches a coding agent CLI. Agents always run unmodified in their own terminal; this only
 * describes the command line. Placeholders: {model}, {sessionId}, {name}.
 */
export interface AgentDef {
  id: string;
  label: string;
  /** Executable name or path. Empty for the plain shell. */
  command: string;
  args?: string[];
  /** Args added when a model is chosen, e.g. ["--model", "{model}"]. */
  modelArgs?: string[];
  /** Model presets shown in the picker. Without presets the picker offers a free-text model field. */
  models?: { value: string | null; label: string }[];
  /** Args that pin the agent's own session id up front, e.g. ["--session-id", "{sessionId}"]. */
  sessionIdArgs?: string[];
  /** Args used when reviving an ended session, e.g. ["--resume", "{sessionId}"]. */
  resumeArgs?: string[];
  /** Args that set a display name, e.g. ["-n", "{name}"]. */
  nameArgs?: string[];
  /** One-character sidebar icon. */
  glyph?: string;
  /**
   * Read-only observer that turns the agent's own hooks/logs into activity, state, context and usage.
   * 'claude': Jarvis passes `--settings` with hooks + a status line tap. 'codex': Jarvis tails its rollout JSONL.
   */
  integration?: 'claude' | 'codex' | null;
  /** Filled in by the daemon. */
  available?: boolean;
  path?: string | null;
  source?: 'builtin' | 'user';
}

/** running: tmux session exists. exited: registry knows it, tmux does not (process ended, reboot). */
export type SessionStatus = 'running' | 'exited';

/** terminal: the agent's own TUI in tmux. rich: driven through the agent's SDK and drawn by Jarvis (RICH-VIEW.md). */
export type SessionMode = 'terminal' | 'rich';

/**
 * Bumped whenever the rich session host (packages/daemon/src/agent-host.ts) gains something the app relies on.
 * Hosts outlive app updates, so a session whose host reports an older number is offered a restart.
 */
export const RICH_HOST_PROTOCOL = 3;

export interface SessionInfo {
  /** Stable short id. External sessions use `ext:<tmux name>`. */
  id: string;
  mode: SessionMode;
  /** Rich sessions: the host process and whether jarvisd is connected to it. */
  rich: { hostPid: number | null; connected: boolean; outdated: boolean } | null;
  tmuxName: string;
  name: string;
  /** True once you named the session; otherwise the name follows Claude's own title for the conversation. */
  nameLocked: boolean;
  /** Another session of yours runs in the same checkout, so the two share its branch and files. */
  sharesCheckout: boolean;
  agent: AgentKind;
  model: string | null;
  /** The agent's own session id when Jarvis can pin it (Claude: --session-id), so revive can resume it. */
  agentSessionId: string | null;
  /** Directory the session was launched in. */
  cwd: string;
  /** Live working directory of the active pane. */
  currentPath: string | null;
  /** Workspace key: main repo root (worktrees group under their main repo), or cwd for non-git dirs. */
  repoRoot: string;
  /** Linked worktree root when the session runs inside one, else null. */
  worktree: string | null;
  branch: string | null;
  hidden: boolean;
  status: SessionStatus;
  createdAt: number;
  exitedAt: number | null;
  /** Last output/input seen by tmux, epoch ms. */
  lastActivity: number | null;
  attachedClients: number;
  paneCommand: string | null;
  panePid: number | null;
  /** Session lives on the default tmux socket (not started by Jarvis). */
  external: boolean;
  order: number;
  /** Live agent state from its observer (null for agents without one). */
  agentState: AgentLiveState | null;
  /** Open PR for this session's branch, if any. */
  pr: PullRequest | null;
}

/**
 * working: agent is mid-turn. needs_input: blocked on you (permission prompt, question).
 * done: finished a turn and is waiting for your next prompt. compacting: summarising context.
 */
export type AgentPhase = 'working' | 'needs_input' | 'done' | 'idle' | 'compacting';

export interface AgentLiveState {
  phase: AgentPhase;
  since: number;
  /** Why it needs you, or the current tool. */
  message: string | null;
  tool: string | null;
  /** The agent's own name for the session (Claude's AI title). */
  title: string | null;
  model: string | null;
  context: { usedPct: number | null; usedTokens: number | null; windowTokens: number | null } | null;
  costUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  subagentsRunning: number;
  toolCalls: number;
  lastPrompt: string | null;
  lastReply: string | null;
}

export type ActivityKind =
  | 'prompt' | 'tool' | 'notification' | 'reply' | 'subagent' | 'compact' | 'session';

export interface ActivityEntry {
  id: number;
  sessionId: string;
  ts: number;
  kind: ActivityKind;
  /** Tool use id for tool entries (start and finish are merged into one entry). */
  toolUseId: string | null;
  tool: string | null;
  /** Subagent that made the call, null for the main agent. */
  agentId: string | null;
  agentType: string | null;
  status: 'running' | 'ok' | 'error' | null;
  durationMs: number | null;
  summary: string;
  /** JSON-encoded tool input (truncated). */
  input: string | null;
  /** Tool output or message text (truncated). */
  output: string | null;
}

export interface FileEntry {
  path: string; // relative to root
  status: string | null; // git porcelain XY, e.g. ' M', '??', 'A '
}

export interface FileContent {
  path: string;
  kind: 'text' | 'image' | 'binary' | 'too-large' | 'missing';
  text?: string;
  dataUrl?: string;
  size: number;
  mtime: number;
}

export interface ChangedFile {
  path: string;
  status: string;
  added: number | null;
  removed: number | null;
}

export interface DocEntry {
  path: string; // absolute
  label: string;
  group: 'Agent instructions' | 'Repo docs' | 'Agents, commands & skills' | 'Plans' | 'Touched this session';
}

export interface PullRequest {
  account: string;
  repo: string; // owner/name
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  updatedAt: string;
  checks: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null;
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  additions: number;
  deletions: number;
  comments: number;
  /** authored by you, or waiting on your review */
  role: 'author' | 'reviewer';
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt: string | null;
}

export interface PrState {
  accounts: string[];
  /** Open PRs, then your PRs merged in the last MERGED_WINDOW_DAYS. */
  prs: PullRequest[];
  updatedAt: number | null;
  error: string | null;
}

export const MERGED_WINDOW_DAYS = 30;

export interface Connector {
  agent: 'claude' | 'codex';
  name: string;
  scope: 'user' | 'project' | 'plugin' | 'claude.ai' | 'repo';
  transport: string | null;
  detail: string | null;
  /** Calls seen in the last 30 days of transcripts. */
  recentCalls: number;
  lastUsed: number | null;
}

export interface RateWindow {
  usedPct: number;
  resetsAt: number | null; // epoch ms
  windowMinutes: number | null;
}

export interface UsageDay {
  day: string; // YYYY-MM-DD local
  agent: 'claude' | 'codex';
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export interface UsageSummary {
  limits: {
    claude: { fiveHour: RateWindow | null; sevenDay: RateWindow | null; asOf: number | null };
    codex: { primary: RateWindow | null; secondary: RateWindow | null; plan: string | null; asOf: number | null };
  };
  days: UsageDay[];
  topProjects: { project: string; agent: 'claude' | 'codex'; tokens: number; costUsd: number | null }[];
  indexing: { done: boolean; files: number; filesDone: number };
  pricingSource: string | null;
  pulse: Pulse;
}

/** The fun numbers. All computed locally from your own transcripts and rollouts. */
export interface Pulse {
  today: {
    tokens: number; costUsd: number | null; outputTokens: number; toolCalls: number;
    linesWritten: number; sessions: number; peakConcurrent: number;
  };
  avgDailyTokens: number;
  avgDailyCostUsd: number | null;
  streakDays: number;
  activeDays30: number;
  cacheHitPct: number | null;
  cacheSavedUsd: number | null;
  topToolsToday: { tool: string; calls: number }[];
  topTools30: { tool: string; calls: number }[];
  /** Tokens by local hour of day over the last 30 days. */
  hours: number[];
  /** Tokens per day for the last 30 days, oldest first. */
  spark: { day: string; tokens: number; costUsd: number | null }[];
  modelMix: { model: string; tokens: number }[];
  records: { bestDay: { day: string; tokens: number } | null; peakConcurrent: { day: string; sessions: number } | null };
  /** Tool calls per minute over the last 5 minutes, across Jarvis sessions. */
  liveToolCallsPerMin: number;
  workingNow: number;
}

export interface WorkspaceInfo {
  root: string;
  name: string;
}

export interface DaemonInfo {
  version: string;
  protocol: number;
  pid: number;
  startedAt: number;
  tmuxSocket: string;
  tmuxPath: string;
  home: string;
}

export interface Snapshot {
  daemon: DaemonInfo;
  /** Set while jarvisd can't see tmux (so session state on screen may be stale), with what to do about it. */
  health: string | null;
  agents: AgentDef[];
  prs: PrState;
  limits: UsageSummary['limits'];
  sessions: SessionInfo[];
  workspaces: WorkspaceInfo[];
}

export interface RepoCandidate {
  path: string;
  name: string;
  /** Main repo root for worktrees. */
  repoRoot: string;
  branch: string | null;
  isWorktree: boolean;
  lastUsed: number | null;
}

export interface AttachSpec {
  file: string;
  args: string[];
}

export interface CreateSessionParams {
  cwd: string;
  agent: AgentKind;
  model?: string | null;
  name?: string | null;
  /** Extra args appended to the agent command line. */
  extraArgs?: string[];
  /** Default terminal. Rich needs an agent with an SDK adapter (Claude). */
  mode?: SessionMode;
  /** Rich sessions: starting permission mode (default: your Claude settings). */
  permissionMode?: RichPermissionMode | null;
  /** Start in a new git worktree (a new branch off the checkout's current commit) instead of the checkout itself. */
  worktree?: { branch?: string | null } | null;
}

export type RichPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

/**
 * What a rich session shows, normalized across agent SDKs. The renderer only knows these.
 * R0 covers text, tools and permissions; streaming deltas, questions and plans come in R1-R2.
 */
export type RichEvent =
  /** queued: sent while Claude was mid-turn; it shows apart until a `user_read` for its uuid. */
  | { kind: 'user'; text: string; uuid?: string; queued?: boolean }
  | { kind: 'user_read'; uuids: string[] }
  | { kind: 'context'; usedPct: number; usedTokens: number; windowTokens: number }
  | { kind: 'text'; text: string; parentToolUseId: string | null }
  | { kind: 'thinking'; text: string; parentToolUseId: string | null }
  | { kind: 'tool_start'; toolUseId: string; tool: string; input: unknown; parentToolUseId: string | null }
  | { kind: 'tool_end'; toolUseId: string; output: string; isError: boolean }
  | { kind: 'permission_request'; requestId: string; tool: string; input: unknown; reason: string | null }
  /** Claude's multiple-choice question (the AskUserQuestion tool); answered with rich.answer, or skipped with rich.respond deny. */
  | { kind: 'question_request'; requestId: string; questions: RichQuestion[] }
  | { kind: 'permission_resolved'; requestId: string; behavior: 'allow' | 'deny'; answers?: Record<string, string | string[]> }
  | { kind: 'status'; model: string | null; permissionMode: string | null; agentSessionId: string | null; cwd: string | null; authSource: string | null }
  | { kind: 'turn_end'; ok: boolean; durationMs: number | null; costUsd: number | null; error: string | null }
  /** Claude is summarising the conversation to free context. Ends with the `compact` that follows. */
  | { kind: 'compacting' }
  | { kind: 'compact'; trigger?: 'manual' | 'auto'; preTokens?: number; postTokens?: number; durationMs?: number; error?: string }
  /** The summary Claude carries forward after a compaction. */
  | { kind: 'compact_summary'; text: string }
  /** Progress of a sub-agent or background command, keyed by the tool call that started it. */
  | {
    kind: 'task'; taskId: string; toolUseId: string | null; state: 'running' | 'done' | 'failed' | 'stopped';
    description: string | null; agentType: string | null; tools: number | null; tokens: number | null; durationMs: number | null;
    lastTool: string | null; progress: string | null; background: boolean;
  }
  /** A message from a background task (finished, stopped, or a monitor's event) that Claude Code injected as a prompt. */
  | { kind: 'task_notice'; taskId: string; toolUseId: string | null; status: 'completed' | 'failed' | 'stopped' | 'event'; summary: string; event: string | null }
  | { kind: 'resumed'; messages: number; shown?: number }
  | { kind: 'error'; message: string }
  | { kind: 'ended'; reason: string };

/** What a running rich session can do, for the / palette and the native pickers. */
export interface RichInfo {
  /** Commands that run when sent as the prompt (built-ins, custom commands, skills). */
  commands: { name: string; description: string; argumentHint: string }[];
  /** Commands that need Claude Code's own screen; Jarvis runs them by reopening the conversation in a terminal. */
  terminalCommands: string[];
  models: { value: string; displayName: string; description: string }[];
  outputStyles: string[];
  account: { email: string | null; organization: string | null; subscription: string | null; authSource: string | null } | null;
  version: string | null;
  model: string | null;
  permissionMode: string | null;
}

/**
 * Slash commands that Claude Code only offers on its own screen: sent through the SDK they answer "isn't
 * available in this environment" (checked against Claude Code 2.1.306). Jarvis builds some of them itself
 * (NATIVE_RICH_COMMANDS) and runs the rest by reopening the conversation in a terminal.
 */
export const SCREEN_ONLY_COMMANDS = [
  'add-dir', 'bashes', 'color', 'copy', 'doctor', 'exit', 'export', 'fast', 'feedback', 'focus', 'help', 'hooks', 'ide',
  'install-github-app', 'keybindings', 'login', 'logout', 'memory', 'permissions', 'plugin', 'privacy-settings',
  'release-notes', 'reload-plugins', 'resume', 'rewind', 'sandbox', 'status', 'statusline', 'tasks', 'terminal-setup',
  'theme', 'todos', 'upgrade', 'vim',
];

/** Commands the rich view handles itself, with what they do there. */
export const NATIVE_RICH_COMMANDS: Record<string, string> = {
  resume: 'Switch to another conversation from this directory',
  context: 'Show what is using the context window',
  rewind: 'Go back to before one of your prompts, as a new conversation (the original is kept)',
  permissions: 'Change the permission mode',
  status: 'Model, account, version and connection details',
  copy: "Copy Claude's last reply",
  export: 'Save the conversation as markdown in ~/Downloads',
  memory: 'Open the CLAUDE.md files this session reads',
  help: 'List every command',
  exit: 'Stop this session (it can be revived)',
};

/** One stretch of the agent's thinking, from its transcript, with the prompt it was answering. */
export interface ThinkingEntry {
  ts: number | null;
  prompt: string | null;
  text: string;
  model: string | null;
}

export interface ThinkingList {
  entries: ThinkingEntry[];
  /** Thinking blocks with no text (the API omitted them; showThinkingSummaries keeps summaries). */
  omitted: number;
  transcript: string | null;
}

/** A local server the web preview can open. */
export interface DevServer {
  port: number;
  url: string;
  command: string;
  pid: number;
  cwd: string | null;
  /** Its process runs inside the session's repo. */
  inSession: boolean;
}

/** The context window, broken down for the context panel (trimmed from the SDK's report). */
export interface RichContext {
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  /** Tokens at which Claude Code compacts by itself, when it is on. */
  autoCompactAt: number | null;
  categories: { id: string; name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[];
  mcp: { server: string; tools: number; tokens: number }[];
  memoryFiles: { path: string; type: string; tokens: number }[];
  agents: { name: string; source: string; tokens: number }[];
  skills: { name: string; source: string; tokens: number }[];
  messages: { label: string; tokens: number }[];
  topTools: { name: string; tokens: number }[];
}

/** A past Claude conversation in the session's directory, for /resume. */
export interface RichConversation {
  agentSessionId: string;
  title: string;
  firstPrompt: string | null;
  lastModified: number;
  sizeBytes: number | null;
  branch: string | null;
  current: boolean;
}

export interface RichQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

export interface RichEnvelope {
  /** Increases by one per event within a host's lifetime. */
  seq: number;
  ts: number;
  /** Rebuilt from the transcript when the host resumed, not seen live. */
  replay?: boolean;
  event: RichEvent;
}

export type PaneDirection = 'left' | 'right' | 'up' | 'down';

/** RPC surface. Keys are method names, values are [params, result]. */
export interface RpcMethods {
  'daemon.info': [void, DaemonInfo];
  'daemon.shutdown': [void, { ok: true }];
  'snapshot': [void, Snapshot];
  'sessions.create': [CreateSessionParams, SessionInfo];
  'sessions.kill': [{ id: string }, { ok: true }];
  'sessions.remove': [{ id: string }, { ok: true }];
  'sessions.revive': [{ id: string }, SessionInfo];
  'sessions.rename': [{ id: string; name: string }, { ok: true }];
  'sessions.setHidden': [{ id: string; hidden: boolean }, { ok: true }];
  'sessions.move': [{ id: string; delta: number }, { ok: true }];
  'sessions.attachSpec': [{ id: string }, AttachSpec];
  'sessions.sendKeys': [{ id: string; text: string; enter?: boolean }, { ok: true }];
  'sessions.capture': [{ id: string; lines?: number }, { text: string }];
  'tmux.split': [{ id: string; direction: 'horizontal' | 'vertical' }, { ok: true }];
  'tmux.selectPane': [{ id: string; direction: PaneDirection }, { ok: true }];
  'tmux.zoom': [{ id: string }, { ok: true }];
  'tmux.clearHistory': [{ id: string }, { ok: true }];
  'tmux.search': [{ id: string }, { ok: true }];
  'tmux.copyMode': [{ id: string }, { ok: true }];
  /** Whether the program in the active pane asked for mouse events (Claude Code's fullscreen TUI does, a shell doesn't). */
  'tmux.mouseState': [{ id: string }, { appMouse: boolean }];
  'repos.list': [void, RepoCandidate[]];
  'agents.list': [{ refresh?: boolean } | void, AgentDef[]];
  'sessions.paste': [{ id: string; text: string }, { ok: true }];
  'tmux.lastBuffer': [{ id: string }, { name: string | null; created: number | null; text: string | null }];
  'rich.history': [{ id: string }, { events: RichEnvelope[]; connected: boolean }];
  'rich.send': [{ id: string; text: string }, { ok: true }];
  'rich.interrupt': [{ id: string }, { ok: true }];
  'rich.respond': [{ id: string; requestId: string; behavior: 'allow' | 'deny'; message?: string }, { ok: true }];
  /** Ctrl+B: move running tool calls (long Bash commands) to the background so the turn continues. */
  'rich.background': [{ id: string }, { backgrounded: boolean }];
  'rich.answer': [{ id: string; requestId: string; answers: Record<string, string | string[]> }, { ok: true }];
  /** /rewind: your recent prompts, newest first, with the message to fork at to rewind to just before each. */
  'rich.rewindPoints': [{ id: string }, { uuid: string; text: string; ts: number | null; before: string | null }[]];
  /** Rewind by forking: a new conversation up to that message, resumed in this session. The original is kept (see /resume). */
  'rich.rewind': [{ id: string; upToMessageId: string }, SessionInfo];
  'rich.context': [{ id: string }, RichContext];
  /** Restart a session's host on the same conversation (picks up a newer host; nothing is lost). */
  'rich.restart': [{ id: string }, SessionInfo];
  'rich.info': [{ id: string }, RichInfo];
  'rich.conversations': [{ id: string }, RichConversation[]];
  /** Switch the session to another conversation (restarts its host with that conversation resumed). */
  'rich.resume': [{ id: string; agentSessionId: string }, SessionInfo];
  'rich.setPermissionMode': [{ id: string; mode: RichPermissionMode }, { ok: true }];
  /** Write the conversation as markdown to ~/Downloads (or JARVIS_EXPORT_DIR) and return the path. */
  'rich.export': [{ id: string }, { path: string; markdown: string }];
  /** Move a Claude session between Claude Code's own screen and the rich view, keeping the conversation. */
  'sessions.switchMode': [{ id: string; mode: SessionMode; command?: string | null }, SessionInfo];
  'preview.servers': [{ root?: string | null }, DevServer[]];
  'thinking.list': [{ id: string }, ThinkingList];
  'activity.list': [{ id: string; limit?: number }, ActivityEntry[]];
  'files.list': [{ root: string }, { root: string; files: FileEntry[]; truncated: boolean }];
  'files.read': [{ path: string }, FileContent];
  'files.changes': [{ root: string }, ChangedFile[]];
  'files.diff': [{ root: string; path: string }, { diff: string }];
  'files.watch': [{ root: string }, { ok: true }];
  'files.touched': [{ id: string }, string[]];
  'docs.list': [{ id: string }, DocEntry[]];
  'prs.refresh': [void, PrState];
  'connectors.list': [{ id: string }, Connector[]];
  'connectors.check': [{ id: string }, { output: string }];
  'usage.summary': [{ days?: number } | void, UsageSummary];
  'open.editor': [{ path: string; line?: number }, { ok: true }];
  'kv.get': [{ key: string }, { value: unknown }];
  'kv.set': [{ key: string; value: unknown }, { ok: true }];
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M][0];
export type RpcResult<M extends RpcMethod> = RpcMethods[M][1];

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
}

export type ServerEvent =
  | { event: 'snapshot'; data: Snapshot }
  | { event: 'activity'; data: ActivityEntry }
  | { event: 'files.changed'; data: { root: string; paths: string[] } }
  | { event: 'attention'; data: { sessionId: string; phase: AgentPhase; message: string | null } }
  | { event: 'rich.event'; data: { sessionId: string; envelope: RichEnvelope } };

/** A session counts as "working" if tmux saw activity this recently. Replaced by hook state in P1. */
export const ACTIVE_WINDOW_MS = 2500;
