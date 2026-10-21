# Rich view: SDK-backed Claude sessions, next to the terminal

Written 2026-10-21 against `@anthropic-ai/claude-agent-sdk` 0.3.306 (it bundles the same Claude Code binary as CLI 2.1.306) and your last 30 days of tool calls.

**Status: R0 done (2026-10-21).** Rich sessions run, render as plain text, ask for permissions, and survive quitting Jarvis, a jarvisd restart, and a killed host (revive resumes from the transcript). Acceptance: `pnpm e2e:rich`, 23 checks, passing in dev and against the packaged app.

## 1. What and why

A second way to run a Claude session in Jarvis: instead of Claude Code's TUI in a tmux pane, the session runs through the Agent SDK and Jarvis draws it. The point is control over how you see the agent run: tool calls as collapsible cards, edits as real diffs, permission prompts as buttons, and view settings you choose (hide reads, group a run of greps into one line, show only edits). The terminal stays the default and stays exactly as it is. Rich is a per-session choice in ⌘T.

This amends the principle in [PLAN.md](PLAN.md) ("a terminal, not an agent UI"). The new rule: the terminal is the universal mode for every agent; agents with a structured API (Claude through the Agent SDK now, Codex through `codex app-server` later) can also run in rich mode, and the two modes share one conversation, so you can move a session between them.

Billing is your plan: the SDK runs the same binary with your `/login` when `ANTHROPIC_API_KEY` is unset, and Anthropic's docs cover "ordinary, individual usage of Claude Code and the Agent SDK" under plan limits.

## 2. What the SDK gives us (checked in the 0.3.306 type definitions)

- **One long-lived conversation.** `query({ prompt: AsyncIterable<SDKUserMessage>, options })` keeps a session open and takes new user messages as you send them. Each `query()` runs one `claude` child process.
- **Live controls on the running session:** `interrupt()`, `setModel()`, `setPermissionMode()` (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`), `applyFlagSettings({ effortLevel })` for effort (applies from the next turn; there is no `setEffort()`), `getContextUsage()`, `supportedCommands()`, `supportedModels()`, `supportedAgents()`, `mcpServerStatus()`, `toggleMcpServer()`, `reconnectMcpServer()`, `rewindFiles()` (with `enableFileCheckpointing`), `stopTask()`, `reloadSkills()`.
- **Permissions as a callback.** `canUseTool(toolName, input, { suggestions, blockedPath, decisionReason, mcpServer })` returns `allow` with `updatedInput` (always pass it) and optionally `updatedPermissions` for "always allow", or `deny` with a message and an optional `interrupt`. Tools your permission rules already allow never reach the callback. That is the permission card.
- **Questions through the same callback.** AskUserQuestion always reaches `canUseTool` with `questions[]` (question, header, options, multiSelect). The answer goes back as `allow` with `updatedInput: { questions, answers }`.
- **Slash commands as plain prompts.** Sending `/compact`, `/clear`, a custom command or a user-invocable skill as the message text runs it. Terminal-only commands reply that they aren't available.
- **Streaming and nesting.** `includePartialMessages` streams text as it is written; `forwardSubagentText` forwards a subagent's full conversation tagged with `parent_tool_use_id`, so subagents render as nested threads instead of a heartbeat.
- **The same transcripts.** Sessions persist to `~/.claude/projects/*.jsonl` by default (`persistSession` defaults to true), with `sessionId` to pin an id and `resume` to continue one. So the existing usage indexer, Pulse and Docs keep working, and `claude --resume <id>` in a terminal opens the same conversation (SDK sessions are left out of the CLI's resume picker and `--continue`, so Jarvis always passes the id). `getSessionMessages(id)` reads history back for rendering, so Jarvis never parses the transcript format itself.
- **The same setup as your CLI.** With `settingSources` omitted, the SDK loads user, project and local settings like the CLI does: CLAUDE.md, your hooks, plugins, skills and MCP servers. The system prompt is the exception: omitted, the SDK uses a minimal one, so the host must pass `systemPrompt: { type: 'preset', preset: 'claude_code' }`. `env` replaces the whole environment, so the host spreads `process.env` into it. `effort`, `thinking`, `agents`, `plugins` and `cwd` are options.

To confirm in R0, not yet verified:
- How ExitPlanMode's plan approval reaches the host. It is a tool, so it should arrive through `canUseTool`, but the docs don't say. `onUserDialog` covers other CLI dialogs.
- Whether a deny with `interrupt: true` stops the turn or just the tool.
- Attachments other than images. Images go in the message as base64 content blocks; for other files, the plan is to pass the path and let Read open it.

## 3. Design

```
Jarvis.app (renderer)                         jarvisd (launchd)
  RichView  <-- ws: rich.event, rpc: rich.* -->  RichSessions registry
                                                    |  unix socket per session
                                                    v
                                     jarvis-agent-host (one per rich session, detached)
                                        query() from @anthropic-ai/claude-agent-sdk
                                           -> claude child process
                                           -> ~/.claude/projects/<cwd>/<id>.jsonl
```

**A host process per rich session, not the SDK inside jarvisd.** The SDK's `claude` child dies when its parent goes away. tmux gives terminal sessions immunity to app quits and daemon restarts; the host process is the rich-mode equivalent. jarvisd spawns `jarvis-agent-host` detached (its own process group, like tmux), each listening on `~/.jarvis/rich/<id>.sock`. Quitting Jarvis or restarting jarvisd leaves it running, and jarvisd reconnects on start. After a reboot or a host crash, revive spawns a new host with `resume: <sessionId>`, the same way terminal revive uses `claude --resume`.

**The transcript is the source of truth for history.** The host keeps a ring of recent live events for fast reattach. Anything older comes from the session's JSONL via `getSessionMessages()`. Jarvis stores no second copy of the conversation, only view state (collapsed cards, scroll position, draft prompt).

**A normalized event model, so Codex can follow.** `packages/protocol` gets `RichEvent`: `user`, `text` (with streaming deltas), `thinking`, `tool_start`, `tool_progress`, `tool_end`, `permission_request`, `question`, `plan_approval`, `subagent_start/end`, `todo`, `compact`, `status` (model, mode, context, cost, rate limits) and `turn_end`. A `RichAdapter` interface (`start`, `send`, `interrupt`, `setModel`, `setMode`, `respond`) has a Claude implementation now and a Codex one later. The renderer only knows `RichEvent`.

**The cockpit keeps working.** Rich sessions load Jarvis's hook settings file through the SDK's `settings` option, with `JARVIS_SESSION` set, so the same Observers see them as terminal sessions. The sidebar's live state, attention notifications, the dock badge, ⇧⌘U, Activity and Pulse treat both modes the same. The host adds what hooks can't see: a pending `canUseTool` becomes a "needs you" state. Your own hooks in `~/.claude/settings.json` still run.

**One writer per conversation.** jarvisd refuses to open a session id in both modes at once. "Open in terminal" closes the host, then starts `claude --resume <id>` in tmux. "Open in rich view" does the reverse.

## 4. The view

The center pane renders a session as a conversation instead of xterm. It reuses the viewer's Shiki highlighting, markdown and diff rendering.

- **Tool cards**, one renderer per tool, picked from your actual mix. In the last 30 days you made 43,969 tool calls: Bash 72%, file tools (Read, Edit, Write, Grep, Glob) 12.5%, MCP 8.4%, and subagents and messaging 5.2%.
  - **Bash:** command with its description, live output with ANSI colors, exit code, duration and a background-task badge. Collapsed to one line when it succeeds, expanded when it fails.
  - **Edit/Write:** an inline diff, and a click opens the file in the viewer at the changed lines.
  - **Read/Grep/Glob:** one line each, with consecutive ones grouped ("read 6 files, 2 searches").
  - **Agent:** a nested thread with the subagent's own tool calls, collapsible, with a running counter while it works.
  - **MCP and API calls** get their own section below, because platform integration testing is a large share of the work.
  - **TodoWrite:** a live checklist pinned above the composer.
- **MCP and native API calls.** In the last 30 days you made about 2,000 calls to your work platform's MCP servers, across its staging, prod and dev environments. Native API calls go through Bash: 883 `curl` calls, plus inline Python scripts (7,243 runs) that often wrap API calls. Integration testing uses both paths, so both get a first-class card and a shared timeline.
  - **MCP card:** a header with server, tool and environment (Staging, Prod, Dev, read from the server name, with Prod in a warning color). Below it: duration, the arguments as a key/value table, and the result as a collapsible JSON tree with search and copy-path. Errors (`is_error` results and error payloads) are expanded and red. Long arrays show their length and the first rows, with a "show all".
  - **API card for Bash:** Bash calls that are HTTP requests get parsed: `curl` method, URL, query, headers and body, plus the response status, timing and JSON body from the output. The header shows `POST /api/v1/...` with the host and status badge, and the body uses the same JSON tree as MCP results. `Authorization`, cookies, tokens and API keys are masked in the view (the raw command stays one click away). Python scripts that print HTTP status lines or JSON fall back to a JSON-aware output view.
  - **Test runs:** pytest, vitest and jest output collapses to a pass/fail summary with the failing tests expanded, and each failure links to its file and line in the viewer.
  - **Calls timeline:** a filter, or a side rail, listing every MCP and HTTP call in the session in order, with environment, status, duration and size. Selecting two calls diffs their payloads, which is the usual integration-testing question ("what changed between the passing run and this one").
  - **Grouping:** a run of calls to the same tool or endpoint collapses to one line ("12 calls to `get_run`, 11 ok, 1 error") that expands in place.
- **Permission card:** tool, input and `decisionReason`, with Allow once, Always allow (sends `suggestions` back as `updatedPermissions`), Deny with a reason, and edit-the-input-then-allow. It also raises "needs you" in the sidebar and a notification.
- **Questions and plans:** AskUserQuestion as a form, and ExitPlanMode as the plan in markdown with Approve and Keep planning.
- **Composer:** multi-line input, ⌘↵ to send, messages queued while the agent works, Esc to interrupt, `@` file mention with the fuzzy finder, image paste, quote-reply from any selected text, and a `/` palette filled from `supportedCommands()`.
- **Status bar:** model, effort and permission-mode pickers that change the live session, plus a context meter from `getContextUsage()`, turn cost, and the 5-hour and weekly limits.
- **View controls**, the main point of all this:
  - **Density:** Focus shows prompts, replies, edits and anything that needs you. Normal adds tool cards. Everything adds thinking, hook output and every read.
  - Per-tool defaults for expanded or collapsed, kept in `~/.jarvis/view.json`.
  - A "changes so far" rail listing every file edited in the session, with +/− counts and click-to-diff.
  - Per-turn duration, tokens and cost.
  - Search within the conversation.
  - Rewind: pick any of your messages and restore files to that point through `rewindFiles()`, with a confirm step.

## 5. Phases, each with a "done when"

| Phase | Scope | Done when |
|---|---|---|
| **R0 Spike** | `jarvis-agent-host`, socket protocol, `rich.*` RPCs; plain text rendering; persistence; confirm the two open questions in section 2 | A rich Haiku session survives quitting Jarvis and `jarvis daemon restart`, and after a host kill, revive resumes it with history drawn from the transcript |
| **R1 Rendering** | `RichEvent` model; streaming text; markdown; Bash, Edit/Write, Read/Grep/Glob, Agent, MCP, API (curl), test-run and TodoWrite cards; the calls timeline; thinking collapsed; interrupt; queued messages | A real day's session renders with no unknown blocks, checked against 20 tool types sampled from your transcripts, and a platform integration-test session reads end to end from the calls timeline alone |
| **R2 Control** | Permission card, questions, plan approval, mode, model and effort switching, `/` palette, `@` mentions, image paste, quote-reply, attention and notifications | A full working session (plan, edits, a test run, a commit) goes end to end without opening the TUI |
| **R3 View controls** | Density modes, grouping, per-tool defaults, changes rail, per-turn cost, search, rewind | You can change how a session looks mid-run, and the setting holds across sessions and restarts |
| **R4 Both modes, then Codex** | "Open in terminal" and "Open in rich view" on one conversation; ⌘T remembers your choice per agent; Codex adapter over `codex app-server` | One conversation moves terminal → rich → terminal with nothing lost, and a Codex session renders with the same cards |

Acceptance: `pnpm e2e` gets a rich section. It starts a rich Haiku session and has it create a file. It allows the permission through the card, quits the app, restarts jarvisd and checks the history. Then it moves the session to the terminal and confirms `claude --resume` shows the same conversation.

## 5a. What R0 built

- `packages/daemon/src/agent-host.ts`, bundled to `dist/jarvis-agent-host.mjs` (1.3 MB, shipped next to `jarvisd.cjs` in the app). One long-lived `query()` with an input queue, `canUseTool` turned into permission events, and SDK messages normalized into `RichEvent`. It serves newline-delimited JSON on `~/.jarvis/rich/<id>.sock` and writes `~/.jarvis/rich/<id>.json` with its pid. On resume it rebuilds history with `getSessionMessages()`.
- `packages/daemon/src/rich.ts`: spawns hosts detached with your login shell's environment, reconnects to running ones when jarvisd starts, relays events, and stops hosts.
- Sessions gain `mode` and `permission_mode` columns. Revive resumes from the transcript and keeps the permission mode.
- RPCs: `rich.history`, `rich.send`, `rich.interrupt`, `rich.respond`, plus a `rich.event` stream. `jarvis new --rich` and `jarvis send` work on rich sessions.
- The app has a View toggle (Terminal or Rich) in ⌘T for Claude, and a plain-text RichView: messages, tool rows with input and output, thinking, Allow and Deny, turn cost, a composer (↵ send, ⇧↵ newline, esc interrupt), and ⌘' quote-reply into the composer.

Measured in R0:
- **Memory:** host 42 to 59 MB plus the `claude` process at 233 to 255 MB. The `claude` part is the same as a terminal session.
- **Plan login:** the SDK reports `apiKeySource: none`, which means your claude.ai login, not an API key.
- **launchd:** a detached child survives its launchd job stopping, so hosts survive a launchd `jarvis daemon restart` the way tmux does.

Answered from R0: ExitPlanMode and deny-with-interrupt are still open, and move to R2 where their cards are built.

## 6. Risks

- **The SDK changes almost daily** (0.3.x, versioned with the CLI). Pin the version and bump it on purpose. The adapter keeps SDK types out of the renderer, and recorded event streams from real sessions become contract tests.
- **Interactive CLI commands have no SDK form**, for example `/login`, `/config`, `/doctor` and the `/mcp` menus. Those get an "Open in terminal" button, which is cheap because both modes share the conversation.
- **Login.** `--bare` ignores your `/login` and skips CLAUDE.md, hooks and skills, and the docs recommend it for SDK scripts, so the host must never pass it. The headless docs also say it "will become the default for `-p`". If the SDK picks that up, R0's acceptance run catches it, and the fallback is a token from `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`. Jarvis asks you to set it once and never reads or stores it.
- **Memory.** Each rich session is one `claude` process, like a terminal session, plus a small Node host. Anthropic's hosting docs size agents at 1 GiB each as a floor, which is in line with what your terminal sessions already use. R0 measures peak RSS for both modes and records it in the README.
- **Your hooks run in rich mode too**, including the claude-mem hooks that currently fail in every session. That is unchanged from the terminal, but the rich view shows hook errors as one muted line instead of a block.

## 7. Decisions I made for you (override any of them)

1. A host process per rich session, so rich sessions are as hard to kill as tmux ones.
2. The transcript is the only conversation store.
3. The terminal stays the default in ⌘T, and rich is a toggle that remembers your last choice.
4. Claude first. Codex comes in R4 through the same event model.
5. Rendering lives in the renderer and reuses the viewer's Shiki, markdown and diff code.
6. Rich sessions reuse Jarvis's hook settings file, so Observers need no second code path (changed during R0; it was "feed Observers directly").
7. Hosts run your installed `claude` (resolved through `~/.local/bin/claude`), the same binary as terminal sessions, not the SDK's bundled 260 MB copy. If a CLI update ever breaks the pinned SDK, the fallback is to point back at the bundled binary.
