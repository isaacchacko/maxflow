#!/bin/sh
# Runs this checkout as a dev maxflow beside the live one: its own port, tmux socket and state dir, and no sentries
# unless asked for, since they act on real GitHub and Slack.
#   ./dev.sh          serve on http://localhost:4748 (MAXFLOW_PORT, MAXFLOW_INSTANCE and MAXFLOW_SENTRIES=1 to change)
#   ./dev.sh kill     end the dev instance's tmux sessions
#   ./dev.sh reset    end them and delete its state dir
set -e
cd "$(dirname "$0")"
# Live panes carry MAXFLOW_PORT=4949, so that value means "not chosen" here rather than a request for the live port.
[ "${MAXFLOW_PORT:-4949}" != 4949 ] || MAXFLOW_PORT=4948
export MAXFLOW_INSTANCE="${MAXFLOW_INSTANCE:-dev}" MAXFLOW_PORT MAXFLOW_SENTRIES="${MAXFLOW_SENTRIES:-0}"
# Started from inside a live maxflow pane, these would point at the live session.
unset MAXFLOW_SESSION
socket="maxflow-v2-$MAXFLOW_INSTANCE"
case "$1" in
  kill) tmux -L "$socket" kill-server 2>/dev/null || true; exit ;;
  reset) tmux -L "$socket" kill-server 2>/dev/null || true; rm -rf "$HOME/.maxflow-v2-$MAXFLOW_INSTANCE"; exit ;;
esac
[ -d node_modules ] || bun install
echo "maxflow $MAXFLOW_INSTANCE: http://localhost:$MAXFLOW_PORT (tmux -L $socket, state ~/.maxflow-v2-$MAXFLOW_INSTANCE)"
exec bun server.ts
