import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { areaOf, createRule, repoPath } from "../rule";

export default createRule({
  name: "fetch-needs-timeout",
  meta: {
    type: "problem",
    docs: { description: "Every server-side fetch has a timeout" },
    messages: {
      timeout:
        "Pass `{ signal: AbortSignal.timeout(ms) }` to this fetch: without one a stalled peer hangs this sentry or the server forever, and nothing notices.",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    if (areaOf(repoPath(context)) === "src") return {};
    return {
      CallExpression(node) {
        if (node.callee.type !== AST_NODE_TYPES.Identifier || node.callee.name !== "fetch") return;
        const init = node.arguments[1];
        if (init && init.type !== AST_NODE_TYPES.ObjectExpression) return;
        const hasSignal = init?.properties.some((p) => p.type === AST_NODE_TYPES.SpreadElement || (p.key.type === AST_NODE_TYPES.Identifier && p.key.name === "signal")) ?? false;
        if (!hasSignal) context.report({ node, messageId: "timeout" });
      },
    };
  },
});
