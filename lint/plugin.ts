import fetchNeedsTimeout from "./rules/fetch-needs-timeout";
import importBoundaries from "./rules/import-boundaries";
import noComments from "./rules/no-comments";
import noKillByPattern from "./rules/no-kill-by-pattern";
import noSyncSpawnInServer from "./rules/no-sync-spawn-in-server";
import stateDirInState from "./rules/state-dir-in-state";
import stateWritesInState from "./rules/state-writes-in-state";

export const yarn = {
  meta: { name: "yarn" },
  rules: {
    "fetch-needs-timeout": fetchNeedsTimeout,
    "import-boundaries": importBoundaries,
    "no-comments": noComments,
    "no-kill-by-pattern": noKillByPattern,
    "no-sync-spawn-in-server": noSyncSpawnInServer,
    "state-dir-in-state": stateDirInState,
    "state-writes-in-state": stateWritesInState,
  },
};
