#!/bin/sh
# Claude Code SessionStart hook: tells a claude started inside a yarn session what yarn is and how to use it. Its stdout becomes context.
# constraint: panes started before the rename to yarn carry only MAXFLOW_*
session=${YARN_SESSION:-$MAXFLOW_SESSION}
[ -n "$session" ] || exit 0
curl -sf -m 2 "http://localhost:${YARN_PORT:-${MAXFLOW_PORT:-4949}}/api/sessions/$session/intro"
exit 0
