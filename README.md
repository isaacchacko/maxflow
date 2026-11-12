# maxflow

Local web terminal for agent work on this machine. A Bun server on `127.0.0.1:4747` runs commands in real PTYs (Bun's built-in `terminal` spawn, no native deps) and streams them to xterm.js in the browser. Every session runs inside tmux on a private socket (`tmux -L maxflow`, config in `tmux.conf`: no prefix, no status bar), so it outlives both the tab and the server: on startup maxflow adopts any `mf-*` tmux sessions, replays their history and reattaches. You can also reach one from a terminal with `tmux -L maxflow attach -t mf-<id>`.

```sh
bun server.ts                      # http://localhost:4747  (MAXFLOW_PORT to change)
./cli.ts new --name api -- bun dev # start a session, prints its link
./cli.ts chats [query]             # list Claude Code chats, newest first
./cli.ts resume <claude-session-id> [--safe] [--force]
./cli.ts ls
```

maxflow is an installable web app (`public/manifest.webmanifest`): in Chrome, open `http://localhost:4747` and choose Install (the icon at the right of the address bar) to get its own window, Dock icon and Launchpad entry.

## Driving from an agent

Everything the browser does is also an HTTP call, so an agent can run a session, type into it and read it back without a websocket:

```sh
id=$(./cli.ts new --name job -- claude); id=${id##*/}
./cli.ts wait $id --match 'trust this folder|❯'   # block until the prompt shows; prints the screen
./cli.ts keys $id Down Enter                      # tmux key names: Enter Escape C-c Up BTab ...
./cli.ts send $id 'fix the failing test'          # types the text, then Enter as a separate keystroke
./cli.ts wait $id --idle 5000 --timeout 600000    # quiet for 5s (claude's spinner counts as output)
./cli.ts screen $id --history 200                 # plain text, no escape codes
./cli.ts kill $id
```

`wait` prints the screen to stdout and its reason (`[match]`, `[idle]`, `[exited]`, `[timeout]`) to stderr, and exits 2 on timeout. The API underneath: `POST /api/sessions/:id/input {text?, keys?, enter?}`, `GET /api/sessions/:id/screen?history=N`, `GET /api/sessions/:id/wait?match=RE&idle=MS&timeout=MS`, `PATCH /api/sessions/:id {name?, archived?}`. After a session ends, `screen` returns the last capture.

## Events and sentries

maxflow has a small event bus (`~/.maxflow/events.jsonl`). Topics are `/`-separated; `*` matches one segment, `**` any number.

```sh
./cli.ts sub 'gh/dryft-ai/app/pr/7031/ci'          # block until the next matching event, print it as JSON
./cli.ts sub 'gh/**' --follow                       # stream
./cli.ts pub some/topic '{"any":"json"}'
./cli.ts notify <id> 'text'                         # typed into the session once it is idle at an empty claude prompt
```

Sentries are sessions the server starts on boot (`MAXFLOW_SENTRIES=0` to skip) and tmux keeps across restarts.

**gh** (`sentries/gh.ts`) runs one GraphQL poll per repo every 30s, covering every PR a live session is tied to. A session is tied to a PR when its cwd has the PR's branch checked out, when it declared the PR with `~/.claude/set-pr.sh` (a bare number resolves against the repo of the PR links the session mentioned), or when it ran `./cli.ts gh watch <pr>` (which defaults to `$MAXFLOW_SESSION`). The sentry publishes `gh/<owner>/<repo>/pr/<n>/{opened,push,ci,review,comment,thread,decision,conflict,merged,closed}`. For CI finishing, reviews, comments, conflicts, merges and closes, it also notifies the tied sessions. It never echoes back comments posted by the gh user itself, since the agents post as that user. State lives in `~/.maxflow/gh-state.json` and `gh-watch.json`.

**slack** (`sentries/slack.ts`) polls Slack every 60s (`SLACK_SENTRY_INTERVAL`) through the `mcp` CLI's `claude.ai/slack` connector, so it needs no token of its own. A session is tied to a Slack thread when its agent posted there with the connector's `slack_send_message` (read from its transcript; the tie lasts 3 days past its last post there, `SLACK_POSTED_TIE_MS`), or when it ran `./cli.ts slack watch <ref>`, where `<ref>` is a message or thread permalink, a channel id or `#name` (its top-level posts), or anything else as a search query (`'from:<@U0C3LKB5BST>'`). The first look at a target only records where it stands; after that every new message is published as `slack/<channel>/<thread ts>/reply`, `slack/<channel>/message` or `slack/search`, and the tied sessions are notified, except of messages they posted themselves. Every mention of the user is published as `slack/mention` for anyone to `sub`, notifying nobody. Explicit watches end once every session they were for has. State lives in `~/.maxflow/slack-state.json` and `slack-watch.json`.

**rename** (`sentries/rename.ts`) titles each session by the topic it owns (the ticket, PR or feature), never its status, so a title only changes when the topic does. A session gets its first title once 400 new characters have reached its screen, then a new one every 4000 (`RENAME_FIRST_CHARS`, `RENAME_EVERY_CHARS`). "New" means lines in the last 300 lines of screen that weren't there at the last rename, so spinner redraws don't count. Each title is one `claude -p --model haiku` call with no tools and no saved transcript, about 1.5s and $0.0001. Rename a session yourself and the sentry leaves it alone from then on.

**graph** (`sentries/graph.ts`) decides which URLs become nodes in the graph view. The server finds every URL a session mentions (an agent's own and its user's messages in the transcript, a shell's tmux history) and serves them with their surrounding text at `GET /api/links`. Every 15s the sentry judges each session's new ones in one `claude -p --model haiku` call, keeping only links meant to be opened (a PR or ticket, a deploy, a published page, a running dev server) and dropping incidental ones (code, docs, CDN, stack traces, maxflow itself). Each URL is judged once per session; verdicts live in `~/.maxflow/graph-links.json`, and a URL stays hidden until judged. It also groups the running sessions by the work they share (one haiku call whenever the set of sessions or their titles change, at most every 2 minutes, `GRAPH_GROUP_EVERY`) into `~/.maxflow/graph-groups.json`; the server serves each session's `group`, and the graph joins every pair in a group with a hidden link that pulls them together without being drawn. Sentries always share one group, `maxflow sentries`, and every session working on maxflow itself shares `maxflow development` (pinned when its title says maxflow or it runs in this repo, otherwise by haiku); the rest are titled like the rename sentry's session titles. Press `hg` in the graph view to outline each group and show its title; `ht` hides node titles but keeps the group titles. `G` acts on a whole group: it outlines and numbers them, `G<n>r` opens the new-agent draft as a router for group n, with every running member picked (so each is introduced to it) and a brief to coordinate them, ready to edit before it starts. A GitHub PR's node is colored by its state, polled every 30s: green open, purple merged, red closed (a lone PR drawn as its domain's node gets a ring in that color around the favicon). Right-click a link (or a domain node, for all its links) to archive it: it is greyed out everywhere it appears and hides along with archived sessions (`ha`). Archived URLs live in `~/.maxflow/archived-links.json`; `PATCH /api/links {urls, archived}` sets them. A domain node shows its site's favicon and a sentry's node an icon for what it watches (a PR for gh, # for slack, a tag for rename, a pulse for health, waypoints for graph); `@isaacchacko/graph` draws both inside the node, ringed in its color, so they dim, highlight and move with it.

**health** (`sentries/health.ts`) polls the server every 15s. Sentries live in tmux, so this one keeps running while the server is down. Once the server has been unreachable for 2 minutes (`HEALTH_DOWN_MS`) while its launchd agent is still loaded, so launchd's own restarts aren't working, it starts a `maxflow recovery` session straight in tmux: `claude` in bypass mode, primed with launchd's status and the tail of `/tmp/maxflow.log`, told to fix the cause, kickstart the agent and confirm it answers. The server adopts that session when it comes back. One agent at a time, and at most one per 15 minutes (`HEALTH_COOLDOWN_MS`). Unloading the launchd agent counts as down on purpose and starts nothing.

## Resuming chats

The **resume** button (or `localhost:4747/#resume`) lists every Claude Code chat under `~/.claude/projects`, newest first, searchable by title, first prompt, folder or id. Picking one runs `claude --resume <id>` in the chat's own folder (with `--permission-mode bypassPermissions` unless the checkbox is off / `--safe`). A chat already open in maxflow reattaches instead of starting twice; one held by another claude process (`ps`) is flagged and needs confirming, since two processes on one transcript fork it.

## Running

Installed as a launchd agent (`~/Library/LaunchAgents/com.isaacchacko.maxflow.plist`), so it starts at login and outlives any shell. Restart after edits with `launchctl kickstart -k gui/$(id -u)/com.isaacchacko.maxflow`; logs in `/tmp/maxflow.log`.

The UI is React + shadcn/ui + Tailwind in `src/`, bundled by Bun from the `src/index.html` import in `server.ts` with hot reload, so edits show up without a restart. Bun reads the Tailwind plugin from `bunfig.toml` in its working directory, so the launchd agent runs from this folder.

Bound to loopback only; requests with a foreign `Origin` are refused, so other sites can't drive it.
