#!/bin/sh
# Runs this checkout as a dev maxflow beside the live one: its own port, tmux socket and state dir, and no sentries
# unless asked for, since they act on real GitHub and Slack.
#   ./dev.sh                    serve on http://localhost:4948 (MAXFLOW_PORT, MAXFLOW_INSTANCE and MAXFLOW_SENTRIES=1 to change)
#   ./dev.sh --seed             the same, first filling its state with fixtures/seed.ts (threads, objectives, tasks, todos)
#   ./dev.sh gc                 delete the ~/.maxflow-v2-<instance> dirs of instances that aren't running
#   ./dev.sh stop <instance>    stop that dev server, by its pid file only
#   ./dev.sh kill <instance>    end its tmux sessions
#   ./dev.sh reset <instance>   end them and delete its state dir
# A dev instance starts at most 10 sessions (MAXFLOW_MAX_SESSIONS), and its claudes run haiku in an empty dir unless
# MAXFLOW_REAL_AGENTS=1 (instance.ts).
# stop, kill and reset act only on an instance named as the argument or in MAXFLOW_INSTANCE, so a bare call can't wipe
# the default "dev" instance someone else is using.
set -e
cd "$(dirname "$0")"
case "$1" in
  stop|kill|reset)
    MAXFLOW_INSTANCE="${2:-$MAXFLOW_INSTANCE}"
    [ -n "$MAXFLOW_INSTANCE" ] || { echo "./dev.sh $1 <instance>: name the instance (dev for the default one)" >&2; exit 1; } ;;
esac
# Live panes carry MAXFLOW_PORT=4949, so that value means "not chosen" here rather than a request for the live port.
[ "${MAXFLOW_PORT:-4949}" != 4949 ] || MAXFLOW_PORT=4948
export MAXFLOW_INSTANCE="${MAXFLOW_INSTANCE:-dev}" MAXFLOW_PORT MAXFLOW_SENTRIES="${MAXFLOW_SENTRIES:-0}"
# Started from inside a live maxflow pane, these would point at the live session.
unset MAXFLOW_SESSION
socket="maxflow-v2-$MAXFLOW_INSTANCE"
state="$HOME/.maxflow-v2-$MAXFLOW_INSTANCE"
# Only the pid this instance wrote, and only while that process still carries this instance's tag, so a reused pid is left alone.
stop() {
  pid=$(cat "$state/server.pid" 2>/dev/null) || return 0
  ps -p "$pid" -o command= 2>/dev/null | grep -q -- "--maxflow-dev=$MAXFLOW_INSTANCE" && kill "$pid"
  rm -f "$state/server.pid"
}
# An instance is running while its server pid is alive (any process: a reused pid is kept rather than risked) or its tmux
# socket still holds sessions. The live state dir is ~/.maxflow-v2, which the glob never matches.
gc() {
  for dir in "$HOME"/.maxflow-v2-*; do
    [ -d "$dir" ] || continue
    name=${dir#"$HOME"/.maxflow-v2-}
    pid=$(cat "$dir/server.pid" 2>/dev/null) || pid=
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "keep $name: server pid $pid is alive"
    elif tmux -L "maxflow-v2-$name" list-sessions >/dev/null 2>&1; then echo "keep $name: tmux -L maxflow-v2-$name has sessions"
    else rm -rf "$dir" && echo "removed $name"
    fi
  done
}
case "$1" in
  gc) gc; exit ;;
  stop) stop; exit ;;
  kill) tmux -L "$socket" kill-server 2>/dev/null || true; exit ;;
  reset) stop; tmux -L "$socket" kill-server 2>/dev/null || true; rm -rf "$state"; exit ;;
esac
[ -d node_modules ] || bun install
if [ "$1" = --seed ]; then
  pid=$(cat "$state/server.pid" 2>/dev/null) && kill -0 "$pid" 2>/dev/null && { echo "maxflow $MAXFLOW_INSTANCE is running (pid $pid); ./dev.sh stop $MAXFLOW_INSTANCE first" >&2; exit 1; }
  bun fixtures/seed.ts "$state"
fi
echo "maxflow $MAXFLOW_INSTANCE: http://localhost:$MAXFLOW_PORT (tmux -L $socket, state ~/.maxflow-v2-$MAXFLOW_INSTANCE)"
# The tag marks this process in ps as this dev instance's server, never the live one.
exec bun server.ts --maxflow-dev="$MAXFLOW_INSTANCE"
