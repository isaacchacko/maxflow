import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule, repoPath } from "../rule";

const OWNERS = new Set(["state.ts", "instance.ts"]);

export default createRule({
  name: "state-dir-in-state",
  meta: {
    type: "problem",
    docs: { description: "Only state.ts reaches into ~/.yarn-v2" },
    messages: {
      stateDir:
        "Only state.ts touches STATE_DIR (~/.yarn-v2): it owns yarn.db and the JSON stores not moved yet. Use its functions instead: a table (threadsTable, tasksTable, ...) for a moved store, readStateJson/writeStateJson/appendStateText/removeState for a file that stays a file. Add one there if none fits.",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    if (OWNERS.has(repoPath(context))) return {};
    return {
      ImportSpecifier(node) {
        const name = node.imported.type === AST_NODE_TYPES.Identifier ? node.imported.name : node.imported.value;
        if (name === "STATE_DIR") context.report({ node, messageId: "stateDir" });
      },
    };
  },
});
