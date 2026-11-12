#!/bin/sh
# Claude Code hook: tells the maxflow session this claude runs in whether it is working, waiting on the user, idle or gone, and where its transcript is.
[ -n "$MAXFLOW_SESSION" ] || exit 0
transcript=$(sed -n 's/.*"transcript_path" *: *"\([^"]*\)".*/\1/p' | head -n 1)
curl -s -m 2 -X POST "http://localhost:${MAXFLOW_PORT:-4747}/api/sessions/$MAXFLOW_SESSION/state" -d "{\"state\":\"$1\",\"transcript\":\"$transcript\"}" >/dev/null 2>&1
exit 0
