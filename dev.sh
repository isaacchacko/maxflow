#!/bin/sh
# Runs this checkout as a dev yarn beside the live one: its own port, tmux socket and state dir, and no sentries
# unless asked for, since they act on real GitHub and Slack.
#   ./dev.sh                    serve on http://localhost:4948 (YARN_PORT, YARN_INSTANCE and YARN_SENTRIES=1 to change)
#   curl localhost:<port>/api/instance  {instance, port, pid}: which instance answers on a port
#   ./dev.sh --seed             the same, first filling its state with fixtures/seed.ts (threads, objectives, tasks, todos)
#   ./dev.sh gc                 delete the ~/.yarn-v2-<instance> (or older ~/.maxflow-v2-<instance>) dirs of instances that aren't running
#   ./dev.sh stop <instance>    stop that dev server, by its pid file only
#   ./dev.sh kill <instance>    end its tmux sessions
#   ./dev.sh reset <instance>   end them and delete its state dir
# A dev instance starts at most 10 sessions (YARN_MAX_SESSIONS), and its claudes run haiku in an empty dir unless
# YARN_REAL_AGENTS=1 (instance.ts).
# stop, kill and reset act only on an instance named as the argument or in YARN_INSTANCE, so a bare call can't wipe
# the default "dev" instance someone else is using.
set -e
cd "$(dirname "$0")"
# constraint: panes started before the rename to yarn carry only MAXFLOW_*, and the server reads YARN_* before them
YARN_INSTANCE="${YARN_INSTANCE:-$MAXFLOW_INSTANCE}" YARN_PORT="${YARN_PORT:-$MAXFLOW_PORT}" YARN_SENTRIES="${YARN_SENTRIES:-$MAXFLOW_SENTRIES}"
unset MAXFLOW_INSTANCE MAXFLOW_PORT MAXFLOW_SENTRIES
case "$1" in
  stop|kill|reset)
    YARN_INSTANCE="${2:-$YARN_INSTANCE}"
    [ -n "$YARN_INSTANCE" ] || { echo "./dev.sh $1 <instance>: name the instance (dev for the default one)" >&2; exit 1; } ;;
esac
# Live panes carry YARN_PORT=4949, so that value means "not chosen" here rather than a request for the live port.
[ "${YARN_PORT:-4949}" != 4949 ] || YARN_PORT=4948
export YARN_INSTANCE="${YARN_INSTANCE:-dev}" YARN_PORT YARN_SENTRIES="${YARN_SENTRIES:-0}"
# Started from inside a live yarn pane, these would point at the live session.
unset YARN_SESSION MAXFLOW_SESSION
socket="maxflow-v2-$YARN_INSTANCE"
state="$HOME/.yarn-v2-$YARN_INSTANCE"
# A dev instance made before the rename to yarn keeps its old state dir.
[ -d "$state" ] || [ ! -d "$HOME/.maxflow-v2-$YARN_INSTANCE" ] || state="$HOME/.maxflow-v2-$YARN_INSTANCE"
# Only the pid this instance wrote, and only while that process still carries this instance's tag, so a reused pid is left alone.
stop() {
  pid=$(cat "$state/server.pid" 2>/dev/null) || return 0
  ps -p "$pid" -o command= 2>/dev/null | grep -qE -- "--(yarn|maxflow)-dev=$YARN_INSTANCE" && kill "$pid"
  rm -f "$state/server.pid"
}
# An instance is running while its server pid is alive (any process: a reused pid is kept rather than risked) or its tmux
# socket still holds sessions. The live state dir is ~/.yarn-v2 (once ~/.maxflow-v2), which the globs never match.
gc() {
  for dir in "$HOME"/.yarn-v2-* "$HOME"/.maxflow-v2-*; do
    [ -d "$dir" ] || continue
    name=${dir#"$HOME"/.yarn-v2-}
    name=${name#"$HOME"/.maxflow-v2-}
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
# Another instance on this port would answer every request meant for this one; a harness polling the port couldn't tell.
if lsof -nP -iTCP:"$YARN_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $YARN_PORT is taken ($(lsof -nP -iTCP:"$YARN_PORT" -sTCP:LISTEN -Fc | sed -n 's/^c//p' | head -1)); pick another YARN_PORT" >&2
  exit 1
fi
if [ "$1" = --seed ]; then
  pid=$(cat "$state/server.pid" 2>/dev/null) && kill -0 "$pid" 2>/dev/null && { echo "yarn $YARN_INSTANCE is running (pid $pid); ./dev.sh stop $YARN_INSTANCE first" >&2; exit 1; }
  bun fixtures/seed.ts "$state"
fi
echo "yarn $YARN_INSTANCE: http://localhost:$YARN_PORT (tmux -L $socket, state $state)"
# The tag marks this process in ps as this dev instance's server, never the live one.
exec bun server.ts --yarn-dev="$YARN_INSTANCE"
