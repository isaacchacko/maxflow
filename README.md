# maxflow

Local web terminal for agent work on this machine. A Bun server on `127.0.0.1:4747` runs commands in real PTYs (Bun's built-in `terminal` spawn, no native deps) and streams them to xterm.js in the browser. Sessions outlive the tab: reload or open a second tab and you reattach, with up to 2 MB of scrollback replayed.

```sh
bun server.ts                      # http://localhost:4747  (MAXFLOW_PORT to change)
./cli.ts new --name api -- bun dev # start a session, prints its link
./cli.ts resume <claude-session-id> [claude flags]  # put a Claude Code chat in the browser
./cli.ts ls
```

Bound to loopback only; requests with a foreign `Origin` are refused, so other sites can't drive it.
