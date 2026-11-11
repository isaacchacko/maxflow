# maxflow

Local web terminal for agent work on this machine. A Bun server on `127.0.0.1:4747` runs commands in real PTYs (Bun's built-in `terminal` spawn, no native deps) and streams them to xterm.js in the browser. Sessions outlive the tab: reload or open a second tab and you reattach, with up to 2 MB of scrollback replayed.

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
