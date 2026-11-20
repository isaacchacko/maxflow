#!/bin/sh
# Claude Code hook: tells the yarn session this claude runs in whether it is working, waiting on the user, idle or gone, and where its transcript is.
# constraint: panes started before the rename to yarn carry only MAXFLOW_*
session=${YARN_SESSION:-$MAXFLOW_SESSION}
[ -n "$session" ] || exit 0
transcript=$(sed -n 's/.*"transcript_path" *: *"\([^"]*\)".*/\1/p' | head -n 1)
curl -s -m 2 -X POST "http://localhost:${YARN_PORT:-${MAXFLOW_PORT:-4949}}/api/sessions/$session/state" -d "{\"state\":\"$1\",\"transcript\":\"$transcript\"}" >/dev/null 2>&1
exit 0
