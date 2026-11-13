#!/bin/sh
# Claude Code SessionStart hook: tells a claude started inside a maxflow session what maxflow is and how to use it. Its stdout becomes context.
[ -n "$MAXFLOW_SESSION" ] || exit 0
curl -sf -m 2 "http://localhost:${MAXFLOW_PORT:-4747}/api/sessions/$MAXFLOW_SESSION/intro"
exit 0
