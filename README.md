# maxflow

Local web terminal for agent work on this machine. A Bun server on `127.0.0.1:4747` runs commands in real PTYs (Bun's built-in `terminal` spawn, no native deps) and streams them to xterm.js in the browser. Every session runs inside tmux on a private socket (`tmux -L maxflow`, config in `tmux.conf`: no prefix, no status bar), so it outlives both the tab and the server: on startup maxflow adopts any `mf-*` tmux sessions, replays their history and reattaches. You can also reach one from a terminal with `tmux -L maxflow attach -t mf-<id>`.

```sh
bun server.ts                      # http://localhost:4747  (MAXFLOW_PORT to change)
./cli.ts new --name api -- bun dev # start a session, prints its link
./cli.ts chats [query]             # list Claude Code chats, newest first
./cli.ts resume <claude-session-id> [--safe] [--force]
./cli.ts ls
```

## Resuming chats

The **resume** button (or `localhost:4747/#resume`) lists every Claude Code chat under `~/.claude/projects`, newest first, searchable by title, first prompt, folder or id. Picking one runs `claude --resume <id>` in the chat's own folder (with `--permission-mode bypassPermissions` unless the checkbox is off / `--safe`). A chat already open in maxflow reattaches instead of starting twice; one held by another claude process (`ps`) is flagged and needs confirming, since two processes on one transcript fork it.

## Running

Installed as a launchd agent (`~/Library/LaunchAgents/com.isaacchacko.maxflow.plist`), so it starts at login and outlives any shell. Restart after edits with `launchctl kickstart -k gui/$(id -u)/com.isaacchacko.maxflow`; logs in `/tmp/maxflow.log`.

Bound to loopback only; requests with a foreign `Origin` are refused, so other sites can't drive it.
