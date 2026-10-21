# Jarvis: a terminal built around running many agents

*Jarvis*: one window that holds every terminal and every coding agent you run (Claude Code, Codex, Pi on a local model, OpenCode, a plain shell), across every repo. CLI `jarvis`, daemon `jarvisd`, tmux socket `-L jarvis`.

**Principle (2026-10-21): Jarvis is a terminal, not an agent UI.** Every agent runs as its own unmodified CLI in a real terminal pane. Jarvis launches, persists, switches and observes them. It never re-implements an agent's chat interface. Agent-specific knowledge lives in small launch recipes (the agent registry) and read-only observers (hooks, session logs), so adding a new agent is a JSON entry, not a feature.

Written 2026-10-21 from your own Claude transcripts (May to Oct 2026), the current open source landscape, and the official Claude Agent SDK, Claude Code hooks and status line docs, and the Codex app-server docs.

---

## 1. Recommendation in one paragraph

Build it yourself, in TypeScript, as two pieces: a long-lived local daemon (`jarvisd`) that owns tmux sessions, tails Claude transcripts, receives agent hook and status line events, and keeps a metrics database; and an Electron + React + xterm.js desktop app that is a thin client of that daemon. tmux (on its own socket) is the persistence layer, so the UI can crash, upgrade or be closed and every agent keeps running. Nothing open source today gives you the "cockpit" you asked for (tool-call and subagent views, file visibility, metrics, any agent in one window), and the two closest projects (cmux, Superset) would make you maintain someone else's product in a stack you do not work in daily. The plan below is phased so that the first usable version (persistent tabs across repos, attention indicators) lands before anything fancy.

---

## 2. What your transcripts say

Source: `~/.claude/projects` (3,985 JSONL files, 2.5 GB). After excluding ~1,000 automated sessions (claude-mem observers, eval-harness judge probes), these are your real interactive sessions since 12 May 2026.

| Measure | Value |
|---|---|
| Interactive sessions | 197 (154 active in the last 30 days) |
| Launched from Claude desktop app vs CLI | 171 vs 26 (87% / 13%) |
| Peak concurrent sessions (10-minute window) | 22. Heavy days run 13 to 17 at once |
| Distinct repos touched per day | 4 to 6 typical, 9 on the busiest day |
| User turns per session | median 40, p75 147, p90 559, max 6,524 |
| Session wall-clock span | p75 about 1 day, p90 about 12 days (resumed sessions) |
| Sessions that spawn subagents | 69%. Median 4 per session, max 117 |
| Tool calls made inside subagents | 27,223 (none of them visible from the terminal today) |
| Top tools | Bash 33.9k, Edit 3.4k, Read 3.3k, Agent 2.0k, browser automation ~1.7k, SendMessage 324 |
| Slash commands typed | /compact 181, /copy 114, /model 91, /effort 9 |
| Tokens (5 months) | 35.4B cache-read, 1.17B cache-write, 109M output |
| Working hours (local) | two bands: 00:00 to 05:00 and 09:00 to 16:00; Tue to Thu heaviest |
| Languages edited | .md 1.9k, .ts/.tsx 2.2k, .py 1.3k, .go 0.7k, .sh 0.5k |

Custom subagent types you run (your eval harness): builder, lesson-scout, source-reader, blind-verifier, plus general-purpose and Explore.

The 2026-10-21 "WezTerm consuming 80 GB" incident: the root cause was orphaned claude-mem worker services, not WezTerm. The real gap was that nothing showed memory per session, so the first signal was the laptop freezing.

What this implies for the design:

- **Session count is the problem, not terminal speed.** 13 to 22 live sessions across 4 to 9 repos means the sidebar, jump keys and "who needs me" state are the core product. The terminal emulator is commodity.
- **Subagents are a first-class view, not a footnote.** Two thirds of sessions fan out, and the fan-out is where the tool calls happen.
- **Sessions live for days.** Persistence (tmux) and resume (Claude session ids) have to be designed in from the start, not bolted on.
- **You switch models constantly** (91 times) and compact constantly (181 times). Those become one-key actions with a visible context gauge instead of typed commands.
- **Resource visibility is a metric that matters**, not just a fun number. Per-session RSS and CPU would have caught the 80 GB incident in minutes.
- **You already live in an Electron app for 87% of sessions** (Claude desktop). An Electron-class terminal is not a downgrade for you as long as it stays memory-disciplined.

---

## 3. Open source survey: what to take, what not to fork

| Project | Stack | License | Nails | Why not the base |
|---|---|---|---|---|
| [cmux](https://github.com/manaflow-ai/cmux) | Swift/AppKit + libghostty | GPL-3.0 (app), BSL (server bits) | Vertical workspace sidebar with branch, PR, ports and last notification; hooks-driven "agent is waiting" rings; Cmd+Shift+U jump to unread; `local-tmux` persistence; socket/CLI API; in-app browser | No tool-call, subagent, file or metrics views. Needs Xcode (you have only Command Line Tools) plus a Zig build of libghostty pinned to a commit whose API Ghostty itself says is in flux. 20k commits and 1.8k open issues: a fast-moving product you would be forking, not a library |
| [Superset](https://github.com/superset-sh/superset) | Electron, React, xterm.js, node-pty, Bun, tRPC | Elastic License 2.0 (source-available, not OSI) | Worktree per task, hook-based status dots, diff viewer, command palette, in-app browser | No tool-call/subagent/metrics views. Dev setup needs Docker, Postgres, Redis and a seeded cloud account (Neon, tRPC): SaaS plumbing you do not want in a personal tool |
| [Wave Terminal](https://github.com/wavetermdev/waveterm) | Go daemon + Electron | Apache-2.0 | File/dir previews, built-in editor, durable sessions, AI chat widget | Not agent-aware at all; block layout is its own opinion; Go backend to learn |
| [Orca](https://github.com/stablyai/orca), [Emdash](https://github.com/generalaction/emdash), [herdr](https://github.com/ogulcancelik/herdr), [claude-squad](https://github.com/smtg-ai/claude-squad), [mulmoterminal](https://github.com/receptron/mulmoterminal) | various | MIT / Apache / AGPL | Parallel agents in worktrees, TUI multiplexing with agent states | Orchestration-first; none has the cockpit, and TUIs cannot give you a bottom-right dropdown window or rich diff/file views |
| [claude-code-trace](https://github.com/delexw/claude-code-trace), [zoetrope](https://docs.rs/zoetrope), [ccusage](https://github.com/ryoppippi/ccusage) | TS / Rust / TS | MIT | Parsing `~/.claude/projects` JSONL for tool calls, subagent graphs, token cost | Standalone viewers; reuse the parsing ideas, not the apps |

Building blocks worth taking as-is: `@xterm/xterm` + `@xterm/addon-webgl` (what VS Code, Superset and Hyper ship), `node-pty`, `node:sqlite` (built into Node 22, no native build), `chokidar`, CodeMirror 6 + Shiki for previews. The Claude Agent SDK and `codex app-server` stay out of the core: they would mean rebuilding agent UIs. Keep an eye on [ghostty-web](https://github.com/coder/ghostty-web): the Ghostty VT core compiled to WASM behind an xterm.js-compatible API, a drop-in upgrade for rendering fidelity once it is stable.

**Verdict:** cmux is the UX benchmark for the terminal half (copy its sidebar and attention model), Superset for status-via-hooks, ccusage/claude-code-trace for the data model. None is the base.

---

## 4. Shell choice: Electron + TypeScript, with the daemon as the real product

| Option | For | Against |
|---|---|---|
| **Electron + React + xterm.js (chosen)** | One language, the one you edit most. Richest toolkit for timelines, trees, diffs, charts. Proven at scale (VS Code, Superset: 100+ agents). Global hotkey + frameless always-on-top window for the dropdown terminal is built in | Memory per terminal; "web app" feel. Mitigated below |
| Native Swift + libghostty (cmux-style) | Best rendering and lowest memory; native feel | Needs Xcode and a Zig toolchain; libghostty API unstable; rich panes end up in WKWebView anyway, so you pay for two stacks |
| Tauri 2 + xterm.js | Smaller binary | WKWebView WebGL quirks for terminals; Node sidecar needed for the daemon; nothing gained for a Mac-only personal tool |

Memory discipline (this is what makes Electron fine for 20 sessions): tmux owns scrollback and process state, so the app only mounts an xterm instance for terminals that are on screen. A background tab is a detached tmux session with no renderer. Switching tabs reattaches in milliseconds. xterm scrollback stays small (tmux `history-limit` is the real history, mouse wheel scrolls tmux). Rough budget: Electron base 200 to 300 MB plus a few MB per visible terminal, independent of how many agents are running.

The daemon-first split keeps the door open: `jarvisd` plus its protocol is the product; the Electron app is one client. If terminal rendering ever becomes the bottleneck, a Swift shell can host libghostty surfaces against the same daemon without touching the cockpit.

---

## 5. System design

```
+------------------------------------------------------------------------------------+
| Jarvis (Electron)                                                               |
| +-------------+ +--------------------------------------+ +-----------------------+ |
| | Sidebar     | | Center: tabs                         | | Inspector             | |
| | api-server  | |  [terminal: tmux attach]  [chat]     | |  Timeline | Files |   | |
| |  * fix/azr  | |                                      | |  Diff | Metrics       | |
| |  o main     | |  xterm.js (WebGL), only when visible | |                       | |
| | meta-harn.. | |                                      | |  tool calls, subagent | |
| |  ! wt1 MH.. | |                                      | |  tree, touched files  | |
| | web-app     | |                                      | |                       | |
| +-------------+ +--------------------------------------+ +-----------------------+ |
| status: 5h 23% | 7d 41% | 6 working, 2 waiting | 2.1M tok today | $12.40          |
+------------------------------------------------------------------------------------+
        |  WebSocket over unix socket (JSON events + RPC)
        v
+------------------------------------------------------------------------------------+
| jarvisd (Node, launchd agent, survives app restarts)                                |
|  registry (SQLite)   tmux controller (-L jarvis)   transcript tailer   hook/status  |
|  metrics + pricing   file/git service             resource sampler    receiver     |
|  agent registry (launch recipes) + observers: claude | codex | pi | any CLI       |
+------------------------------------------------------------------------------------+
        |                      |                          |
     tmux server            ~/.claude/projects/**.jsonl   `claude` hooks + statusLine
     (sessions persist)     (+ subagents/*.jsonl)         codex/pi hooks + session logs
```

### 5.1 `jarvisd` daemon

- **Session registry** (SQLite): workspace (repo path, display name, color) to sessions: tmux session name, agent kind, Claude session id or Codex thread id, model, effort, permission mode, state, cwd, branch, PR, created/last-active, custom title.
- **tmux controller.** Own socket (`tmux -L jarvis`) and own config that sources `~/.tmux.conf` then overrides: `status off`, `mouse on`, `history-limit 50000`, `extended-keys on`, `allow-passthrough on`, `focus-events on`, `destroy-unattached off`. Your prefix, vi copy mode and clipboard bindings keep working. Operations: new session (`-c cwd`), attach, kill, `send-keys`, `capture-pane`, `list-sessions -F` polling for activity, and "adopt" of sessions on your default socket so existing tmux work shows up too. Reboot survival stays with tmux-resurrect/continuum, which you already have.
- **Launching Claude.** `claude --session-id <uuid>` inside the tmux session, so the transcript path is known before the first byte: `~/.claude/projects/<cwd with slashes as dashes>/<uuid>.jsonl`. Resume is `claude --resume <uuid>` in the same tmux session. Worktree-per-task is `git worktree add` + the same flow.
- **Transcript tailer.** Watches `~/.claude/projects/**` and parses JSONL incrementally: entry types `user`, `assistant`, `system` (subtypes `turn_duration`, `stop_hook_summary`, `compact_boundary`, `away_summary`), `custom-title`, `pr-link`, `queue-operation`, `file-history-snapshot`; fields `uuid`/`parentUuid`, `isSidechain`, `agentId`, `message.content` blocks (`text`, `thinking`, `tool_use{id,name,input}`, `tool_result{tool_use_id,content}`), `toolUseResult`, `message.usage`, `message.model`, `requestId`, `gitBranch`, `version`. Subagents live at `<session>/subagents/agent-<id>.jsonl` with a sibling `.meta.json` carrying `agentType`, `description`, `toolUseId` (links to the parent `Agent` call) and `spawnDepth`. The format is internal to Claude Code and undocumented, so the parser is versioned, tolerant of unknown entries, and tested against your 2.5 GB corpus.
- **Hook receiver.** `jarvis hook` is a tiny command installed into `~/.claude/settings.json` (appended next to your GSD and claude-mem hooks, never replacing them) for: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification` (matchers `permission_prompt`, `idle_prompt`, `agent_needs_input`, `elicitation_dialog`, `agent_completed`), `SubagentStart`, `SubagentStop`, `Stop`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `SessionEnd`. It posts the stdin JSON to the daemon socket and exits 0 (`async: true`, so it never slows Claude). This is how "waiting on you" lights up within a second instead of being inferred from screen scraping.
- **Status line tap.** `jarvis statusline` forwards the status line JSON to the daemon and then execs your existing `gsd-statusline.js`, so nothing visible changes. That JSON already carries `model`, `context_window.used_percentage`, `cost.total_cost_usd`, `cost.total_lines_added/removed`, and `rate_limits.five_hour / seven_day {used_percentage, resets_at}` for Max subscribers. Free rate-limit gauges, refreshed every time Claude repaints.
- **Agent registry (built in P0).** Each agent is a launch recipe: command, extra args, model flag, model presets, and optional session-id / resume / name args with `{model}`, `{sessionId}`, `{name}` placeholders. Built-ins: claude, codex, pi, opencode, gemini, aider, shell. `~/.jarvis/agents.json` adds or overrides entries by id, so a local model is one line, e.g. `{"id": "pi-local", "label": "Pi (local)", "command": "pi", "args": ["--provider", "ollama"], "modelArgs": ["--model", "{model}"]}`. Availability is detected through your login shell. When an agent can pin its session id up front (Claude's `--session-id`), Jarvis does, so revive can `--resume` it.
- **Observers, one event model.** Observers only read what an agent already emits, so the agent's own TUI is never replaced. Each emits the same `AgentEvent` stream: `session.started/ended`, `turn.started/ended`, `message.user/assistant`, `tool.call {id, name, input, parentToolId, agentId}`, `tool.result {id, output, isError, durationMs}`, `subagent.spawned/finished {agentId, type, description, depth}`, `attention {permission | question | idle | elicitation}`, `model.changed`, `compacted`, `usage {tokens by kind, model, costUsd}`, `state {running | idle | requires_action}`.
  - `claude`: transcript tailer + hooks + status line (P1).
  - `codex`: rollout JSONL under `~/.codex/sessions` plus Codex hooks (verify layout once installed).
  - `pi`, `opencode`, others: their session files or hooks where they exist; otherwise the generic terminal signals (activity, bell, OSC 9/777 notifications) still drive the sidebar.
- **Metrics.** One-time backfill of every JSONL you have (same approach as ccusage: usage per assistant message, priced from the LiteLLM model-price table, cache tokens priced separately) into SQLite, then live from events. Resource sampler walks each tmux pane's process tree every few seconds for RSS and CPU per session.
- **File and git service.** Directory listing with chokidar watch, `git status` decorations, `git diff` (working tree vs HEAD, or per-edit before/after from `toolUseResult.oldString/newString`), "touched by this session" index built from Edit/Write/MultiEdit events and `file-history-snapshot.trackedFileBackups`, file read for preview.
- **API.** WebSocket on a unix socket (events + RPC) and a `jarvis` CLI over it, so your agents can drive the terminal too: `jarvis new --repo api-server --agent claude --model opus`, `jarvis notify "deploy done"`, `jarvis open path/to/file`, `jarvis sessions`.

### 5.2 Desktop app

- **Sidebar**: repos as groups, sessions as rows: status dot (working / waiting on you / idle / done), agent icon, model badge, context % ring, branch, PR number, unread badge, last notification text. Click or Cmd+1..9. Drag to reorder.
- **Center**: one terminal per session (xterm attached to its tmux session), with Cmd+D / Cmd+Shift+D splits inside a tab mapped to tmux panes. Claude agent teams in split-pane mode already use tmux, so teammates appear as splits for free.
- **Inspector** (Cmd+J to toggle): Timeline, Files, Diff, Metrics tabs, scoped to the active session.
  - **Timeline**: turns as sections; each tool call is one row with the name, a smart summary (Bash: first line of the command; Edit: path and +/- lines; Agent: description; browser tools: action), duration and status. Expand for the full input and output (ANSI-aware, collapsible, searchable). Subagents nest under their `Agent` call as a tree (agentId, type, depth) with their own tool rows, live. Filters: errors only, by tool, by agent. Click a path to open it in Files.
  - **Files**: tree rooted at the session cwd with git decorations and a "touched by this session" filter; preview with syntax highlighting, images, rendered markdown; "open in editor" (`code`, `cursor`, or `nvim` in a split).
  - **Diff**: working tree vs HEAD, or the exact before/after of any Edit from the timeline.
  - **Metrics**: 5h and 7d rate-limit gauges; tokens and cost today / this week by model and repo; cache hit ratio; agents working vs waiting now; tool calls per minute sparkline; lines added/removed today; subagents spawned today; longest-running session; per-session RSS/CPU with a "top" view; streak days; total "Claude hours" (sum of API time).
- **Quick actions bar**: per-agent shortcuts that type into the agent's own TUI via `tmux send-keys`, defined in the registry. For Claude: Model (`/model <alias>`, confirmed by `PostModelSwitch`), Effort, Compact (`/compact`), Copy last response (`/copy`). Codex and Pi get their own slash commands the same way.
- **Command palette** (Cmd+Shift+P, matching your WezTerm binding): fuzzy over sessions, repos, files in the active repo, actions ("new session in web-app with sonnet", "attach tmux session X", "switch model").
- **Attention**: macOS notification + dock badge when a session needs you; Cmd+Shift+U jumps to the most recent one (cmux's best idea).
- **Dropdown terminal**: global hotkey (default Ctrl+`) registered with Electron `globalShortcut`; a frameless, always-on-top window anchored bottom-right (size remembered), attached to a `scratch` tmux session whose cwd follows the active workspace; hides on Esc or blur.
- **Keybindings** keep your WezTerm muscle memory: Cmd+T new session (picker: repo, agent, model, worktree?), Cmd+W close tab (tmux session keeps running unless you choose kill), Cmd+1..9, Cmd+Shift+[ ], Cmd+D / Cmd+Shift+D, Cmd+Z zoom pane, Cmd+K clear, Cmd+F search, Cmd+Enter maximize, Cmd+= / Cmd+-, Cmd+Shift+arrows pane focus. New: Cmd+J inspector, Cmd+E files, Cmd+I timeline, Cmd+Shift+M model, Cmd+Shift+U needs-attention, Ctrl+` dropdown.
- **Look**: rose-pine-moon, JetBrainsMono Nerd Font 12.5, same opacity/blur as your WezTerm config, so day one feels familiar.

### 5.3 Repo layout

```
jarvis/
  apps/desktop/        Electron main + React renderer (electron-vite, Tailwind, Zustand)
  apps/cli/            `jarvis` command (talks to the daemon socket; also the hook/statusline shims)
  packages/daemon/     `jarvisd`: registry, tmux, tailer, hooks, adapters, metrics, files, API
  packages/protocol/   AgentEvent + RPC types (zod schemas), shared by all three
  packages/transcript/ Claude JSONL parser (+ fixtures cut from your real transcripts)
  launchd/             com.ayush.jarvisd.plist
```

pnpm workspaces (you use pnpm daily), Node 22, TypeScript strict, Vitest. The daemon uses `node:sqlite`, so it has no native modules. Electron main holds just the PTYs for attached xterms (node-pty's N-API prebuilds, no rebuild) and the windows.

---

## 6. Build phases, each with a "done when"

| Phase | Scope | Done when |
|---|---|---|
| **P0 Foundations** (done 2026-10-21) | Monorepo; daemon under launchd; tmux controller; Electron window with sidebar + xterm attached to tmux; Cmd+T new-session picker; Cmd+1..9; registry persisted; keybindings and theme ported | You launch 5 Claude sessions in 3 repos, quit the app, relaunch, and all 5 reattach with scrollback and state intact |
| **P1 Awareness** (done 2026-10-21) | Hook + status line installers (append-only); state machine (running / waiting / idle); sidebar dots, badge, macOS notifications; Cmd+Shift+U; transcript tailer + Timeline for the main agent | A permission prompt in a background session lights up within 1 s and the jump key lands on that pane |
| **P2 Subagents + Files** (done 2026-10-21) | Subagent tree in Timeline; Files pane with touched filter, preview, Diff pane | A session with 10 subagents shows each one's tool calls live and the files each edited, with before/after diffs |
| **P3 Controls + Metrics** (metrics done; quick-action buttons pending) | Quick actions (model, effort, permission, compact, copy); rate-limit gauges; metrics backfill of all history; per-session RSS/CPU | Picking a model in the UI changes it in a running CLI session and the badge updates from `PostModelSwitch`; the metrics pane shows the last 5 months |
| **P4 Dropdown + CLI** | Global-hotkey scratch terminal; command palette polish; `jarvis` CLI so agents can open sessions and files and send notifications | Ctrl+` from any app shows the terminal bottom-right in the active repo's cwd |
| **P5 More agents** | Codex and Pi observers (session logs, hooks) feeding the same Timeline and attention model; per-agent resume recipes; worktree-per-task in the picker | A Codex session and a Pi session on a local model run beside Claude with tool calls in the Timeline |

Phase order is by daily value: P0 + P1 alone replace WezTerm for you.

**Cockpit (shipped 2026-10-21, after P0):** observers for Claude (hooks + status line via `--settings`, never touching `~/.claude/settings.json`) and Codex (rollout logs); live session state with notifications, dock badge and ⇧⌘U; Activity timeline with subagent attribution; Files / Changes / Docs navigator and a split file viewer (Shiki, markdown, diffs, `@path#L` references); PRs across all gh accounts; MCP connectors with real call counts; Pulse (plan limits, usage history, fun numbers); quote-reply. Acceptance: `pnpm e2e`, 44 checks.

**Next, in order:**
1. Quick actions: model / effort / compact buttons that type the agent's own slash commands.
2. P4: the global-hotkey dropdown terminal.
3. An always-on host: jarvisd + tmux on a machine that stays awake (SSH), so agents keep working with the lid closed.
4. Verify Codex CLI and Pi recipes once installed (resume args, approval events).

P0 shipped with more than planned: the agent registry (any CLI agent, `~/.jarvis/agents.json`), revive with `claude --resume` after a session's tmux is gone, a quick switcher (⌘P), and a packaged `Jarvis.app`. Its acceptance test is `pnpm e2e` (see README).

---

## 7. Risks and how the design absorbs them

- **Claude transcript format is internal and can change.** Versioned parser, unknown entries ignored, fixtures from your real corpus, and hooks as a second independent signal for state.
- **Many terminals in Electron.** Only visible terminals are mounted; tmux holds everything else. Measure RSS in P0 with 20 sessions and record the number in the README.
- **Hook coexistence.** GSD and claude-mem already own hooks; the installer appends matchers and never rewrites yours. Async hooks so a daemon outage can never block Claude.
- **Keys through tmux.** Shift+Enter, Option+Arrow and friends need `extended-keys on` and xterm's modifyOtherKeys handling; test against Claude Code's and nvim's bindings in P0.
- **Rate-limit fields only arrive after the first API response per session** and only for Pro/Max; the gauges read "unknown" until then rather than 0.
- **Codex specifics** (session file layout, hooks) are from third-party write-ups; verify against the installed version in P5.
- **libghostty / ghostty-web** are not stable yet; xterm.js is the default, with ghostty-web as a later swap behind the same API.

---

## 8. Decisions I made for you (override any of them)

1. **Name: Jarvis** (your choice), CLI `jarvis`, daemon `jarvisd`. No `jarvis` binary on your PATH.
2. **Electron + TypeScript**, not native Swift. Reason: your fluency, no Xcode, and the cockpit is 90% of the value.
3. **tmux on a private socket** rather than the app owning PTYs. Reason: you asked for it, it gives crash/upgrade immunity, and `ssh`/phone access later is free.
4. **Wrap your existing status line and hooks** instead of replacing them.
5. **Agent-agnostic from P0.** Agents are launch recipes in a registry (`~/.jarvis/agents.json` for your own). Codex and Pi observers come in P5; until then they already run, persist and revive like Claude, without the Timeline.
7. **No agent UI re-implementation.** No SDK-driven chat panes; agents keep their own TUIs.
6. **Mac only.** No cross-platform concessions.

---

## Sources

- cmux: https://github.com/manaflow-ai/cmux and https://nativeai.agency/hub/guides/terminals-for-the-agentic-era/
- Superset: https://github.com/superset-sh/superset, https://docs.superset.sh/agent-status, https://www.mintlify.com/superset-sh/superset/resources/faq
- Wave Terminal: https://www.waveterm.dev/, https://github.com/wavetermdev/waveterm
- Orca, herdr, Emdash, claude-squad, mulmoterminal: https://www.codeagentswarm.com/en/guides/best-tools-to-run-multiple-ai-coding-agents, https://github.com/receptron/mulmoterminal, https://www.linuxlinks.com/herdr-terminal-based-agent-multiplexer/
- Transcript viewers: https://cdn.jsdelivr.net/gh/delexw/claude-code-trace@main/README.md, https://docs.rs/zoetrope
- libghostty status: https://ghostty.org/docs/install/release-notes/1-3-0, https://mitchellh.com/writing/libghostty-is-coming, https://github.com/coder/ghostty-web
- xterm.js WebGL addon: https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0.19.0/README.md
- Claude Agent SDK (TypeScript): https://code.claude.com/docs/en/agent-sdk/typescript
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code status line: https://code.claude.com/docs/en/statusline
- Claude Code agent teams (tmux split panes): https://code.claude.com/docs/en/agent-teams
- Codex app-server: https://learn.chatgpt.com/docs/app-server.md, https://developers.openai.com/codex/sdk
- Codex session files (third-party, verify): https://codex.danielvaughan.com/2026/04/11/codex-cli-session-lifecycle-resume-fork-rollouts
- tmux control mode background: https://github.com/tmux/tmux/wiki/Control-Mode
