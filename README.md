# maxflow

**A local web terminal for running a fleet of Claude Code agents, and the sentries that keep them moving.**

maxflow runs every agent in its own terminal session on your machine, shows them all in one browser tab as a sidebar and a live graph, and surrounds them with *sentries*: small background processes that watch GitHub, Slack, CI, RAM and the agents themselves, and type what each agent needs to know straight into its prompt. You stop polling. The agents stop polling. You answer questions when they matter and otherwise watch the work flow.

```
┌─ sidebar ─────────┐  ┌─ terminal / graph ──────────────────────────────────┐
│ ● api#7031  ci ✓  │  │                                                      │
│ ● fix-login  …    │  │   [gh] ──── api#7031 ──── PR 7031 (open)             │
│ ◌ docs  asleep    │  │                │                                     │
│ ── sentries ──    │  │   [slack] ── fix-login ── #eng thread                │
│ gh slack review   │  │                                                      │
│ funnel questions  │  │   [questions] ── docs                                │
│ ? 2 questions     │  │                                                      │
└───────────────────┘  └──────────────────────────────────────────────────────┘
```

## Why

Running five or ten coding agents at once breaks down in boring ways: terminals scattered across windows, agents burning turns on `gh pr checks` in a loop, every agent asking you something at once, comments on a PR that no agent ever hears, a test suite that eats the laptop. maxflow fixes the plumbing:

- **Sessions that never die.** Every session is a real PTY inside a private tmux server, so it survives closing the tab and restarting maxflow. On boot the server adopts and reattaches every one.
- **Everything is an HTTP call.** The browser and agents use the same API, so an agent can start another agent, type into it, wait for its prompt and read its screen with a one-line CLI.
- **Push, not poll.** An event bus plus sentries turn "is CI done yet?" into a message that lands in the agent's prompt when CI is done.
- **One queue for your attention.** Agents raise questions through `maxflow ask`; a gate bounces the ones they should decide themselves, and the rest wait for you in one panel.
- **A picture of the work.** The graph view draws sessions, the PRs, tickets and pages they touch, and which sentries are watching them, grouped by the work they share.

## Features

| | |
|---|---|
| **Web terminal** | xterm.js over Bun's built-in PTY spawn (no native deps), tmux-backed, installable as a desktop app (PWA). |
| **Agent CLI** | `new`, `send`, `keys`, `screen`, `wait`, `notify`, `kill`: drive any session from a script or another agent. |
| **Resume** | Search every Claude Code chat on the machine and reopen it in its own folder, without forking a transcript that is already open. |
| **Graph view** | Sessions, links and sentries as a force graph; PR nodes colored by state; groups by shared work; keyboard chords for everything. |
| **Event bus** | Append-only JSONL with `/`-separated topics and `*` / `**` globs: `maxflow sub 'gh/**'`. |
| **Sentries** | GitHub, Slack, review queue, request funnel, question gate, slow-agent coach, RAM guard, self-healing, titles, graph curation. |
| **Agent intro** | A `SessionStart` hook tells every Claude Code agent where it is, its id, and how to use each running sentry. |
| **Sleep, don't wait** | Agents declare what they wait on (`ci:<pr>`, `approval:<pr>`, `q:<id>`, `agent:<id>`) and are archived until the event wakes them. |

## Quick start

Requirements: macOS or Linux, [Bun](https://bun.sh) 1.3+, `tmux`, and [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) for the agent features. The GitHub sentry uses the `gh` CLI; the Slack sentry uses an `mcp` CLI with a Slack connector.

```sh
git clone https://github.com/isaacchacko/maxflow
cd maxflow
bun install
bun server.ts            # http://localhost:4747  (MAXFLOW_PORT to change)
```

Open <http://localhost:4747>, press **new**, and you have a terminal. In Chrome, use **Install** in the address bar to give maxflow its own window and Dock icon.

Start without the sentries while you try it out:

```sh
MAXFLOW_SENTRIES=0 bun server.ts
```

### Hook it into Claude Code

maxflow learns what each agent is doing (working, waiting on you, idle, gone) and briefs it on start through Claude Code hooks. Add these to `~/.claude/settings.json`, with the path pointing at your clone. Each command is a no-op outside maxflow.

```jsonc
{
  "hooks": {
    "SessionStart":      [{ "hooks": [
      { "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-state.sh idle || true" },
      { "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-intro.sh || true" } ] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-state.sh working || true" }] }],
    "PreToolUse":        [{ "hooks": [{ "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-state.sh working || true" }] },
                          { "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-questions.ts || true" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-state.sh waiting || true" }] }],
    "Stop":              [{ "hooks": [
      { "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-state.sh idle || true" },
      { "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-questions.ts || true" } ] }],
    "StopFailure":       [{ "hooks": [{ "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-state.sh idle || true" }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "[ -n \"$MAXFLOW_SESSION\" ] && ~/maxflow/hooks/claude-state.sh gone || true" }] }]
  }
}
```

### Keep it running (macOS)

Run the server as a launchd agent so it starts at login and restarts if it crashes. Create `~/Library/LaunchAgents/com.example.maxflow.plist`, with `RunAtLoad` and `KeepAlive` set, `ProgramArguments` = `bun /path/to/maxflow/server.ts`, and `WorkingDirectory` = the clone (Bun reads its Tailwind plugin from `bunfig.toml` there). Then:

```sh
launchctl load ~/Library/LaunchAgents/com.example.maxflow.plist
launchctl kickstart -k gui/$(id -u)/com.example.maxflow   # restart after server edits
```

The UI hot-reloads on its own; only `server.ts` changes need a restart.

## Driving it from an agent

Everything the browser does is an HTTP call, so the CLI is a thin wrapper (`./cli.ts`, or `maxflow` once linked with `bun link`):

```sh
id=$(maxflow new --name job -- claude); id=${id##*/}
maxflow wait $id --match 'trust this folder|❯'   # block until the prompt shows; prints the screen
maxflow keys $id Enter                           # tmux key names: Enter Escape C-c Up BTab ...
maxflow send $id 'fix the failing test'          # types the text, then Enter
maxflow wait $id --idle 5000 --timeout 600000    # quiet for 5s
maxflow screen $id --history 200                 # plain text, no escape codes
maxflow kill $id
```

Talking to agents and the bus:

```sh
maxflow notify <id> 'CI is green on #7031'       # typed in once the agent is idle at an empty prompt
maxflow link <id> <id> 'both touch the auth middleware'   # introduce two agents to each other
maxflow ask 'Ship behind a flag or not? Evidence… I recommend the flag.'   # queue a question for the human
maxflow sub 'gh/acme/api/pr/7031/ci'             # block until the next matching event, print JSON
maxflow pub some/topic '{"any":"json"}'
maxflow gh status 7031                           # CI, reviews, open threads from the sentry's last poll
maxflow slack read '#eng' --last 20
```

Run `./cli.ts` with no arguments for every verb. The HTTP API underneath is listed in the [reference](docs/reference.md).

## Sentries

Sentries are sessions the server starts on boot and tmux keeps across restarts. Some are plain scripts; the ones marked *agent* are Claude Code agents with a brief in `sentries/*.md` and a script feeding them.

| Sentry | What it does |
|---|---|
| **gh** | One GraphQL poll per repo every 30s for every PR an agent is tied to (by checked-out branch or explicit watch). Publishes CI, review, comment, conflict and merge events and notifies the tied agents. Never echoes an agent's own posts back to it. |
| **slack** | Polls the threads, channels and searches agents posted in or watch, every 60s, and notifies them of new replies. Publishes every mention of you as `slack/mention`. |
| **review** *(agent)* | Keeps your queue of open PRs moving toward merged or closed: stages each PR, revives the chat that opened it when a comment lands that nobody heard, and tells you what's next. |
| **funnel** *(agent)* | The front door for your requests: finds the agent that owns the request's root (ticket, PR, bug), or resumes or starts one, delivers it, and links in agents whose context helps. |
| **questions** | The throttle on your attention. Every `maxflow ask` goes through a quick model check; what the agent should decide itself is bounced back, the rest waits in the Questions panel. |
| **meta** *(agent)* | Reads every agent's transcript every 15 minutes, times turns, tool calls and model replies, and coaches the slow ones. Keeps lessons that every new agent is told. |
| **ram** | Kills local test, lint, typecheck and build jobs an agent starts once they use too much RAM, and tells it to push and let CI run them. |
| **assistant** *(agent)* | Keeps your task board (⌘K): derives each task from what you ask for and moves it through todo, doing, waiting on you, waiting on others, and done, as the agents work. |
| **health** | Watches the server. Within seconds of it going down, serves a "down" page on its port; if it stays down for 45 seconds, starts a recovery agent to fix and restart it. |
| **rename** | Titles each session by the topic it owns, with one cheap Haiku call per few thousand characters of new output. |
| **graph** | Decides which URLs an agent mentions are worth a node in the graph, and groups sessions by the work they share. |

Each one's thresholds, state files and environment variables are in the [reference](docs/reference.md#events-and-sentries).

## How it works

```
browser (React, xterm.js)  ─┐
agents (./cli.ts, curl)    ─┼─▶  server.ts (Bun, 127.0.0.1:4747)  ──▶  tmux -L maxflow  ──▶  mf-<id> sessions
Claude Code hooks          ─┘          │                                                   (claude, shells, sentries)
                                       ├─ ~/.maxflow/events.jsonl   event bus
                                       └─ ~/.maxflow/*.json         sentry state, questions, graph
```

- `server.ts`: HTTP and websocket server, session lifecycle, tmux adoption, the agent intro, the question queue.
- `cli.ts`: the `maxflow` command.
- `bus.ts`: the event bus.
- `chats.ts`: indexes Claude Code transcripts under `~/.claude/projects` for resume.
- `sentries/`: one file per sentry; `.md` files are agent briefs.
- `hooks/`: the Claude Code hooks.
- `src/`: the UI (React, shadcn/ui, Tailwind), bundled by Bun with hot reload.

## Security

maxflow is a remote shell into your machine, so it binds to loopback only and refuses requests whose `Origin` is another site, so a web page you visit can't drive it. Don't expose port 4747 to a network. Sessions it starts with `--permission-mode bypassPermissions` run Claude Code without permission prompts; turn that off by unticking **Bypass permissions** in the resume dialog or passing `--safe`.

## Status

maxflow is a personal tool, built for one person running many agents on one Mac every day. It moves fast, a few sentries assume conventions from that setup (for example how a GitHub repo maps to a local checkout), and nothing about its API is stable. Issues and ideas are welcome.
