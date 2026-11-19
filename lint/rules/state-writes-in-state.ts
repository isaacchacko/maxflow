import { AST_NODE_TYPES, ASTUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { DefinitionType } from "@typescript-eslint/scope-manager";
import { calleeName, createRule, repoPath } from "../rule";

const WRITES = new Set(["writeFileSync", "appendFileSync", "writeFile", "appendFile", "renameSync", "rmSync", "unlinkSync", "write"]);
const MAX_TRACE = 4;

function isWrite(callee: TSESTree.Expression) {
  const name = calleeName(callee);
  if (name !== "write") return WRITES.has(name);
  return callee.type === AST_NODE_TYPES.MemberExpression && callee.object.type === AST_NODE_TYPES.Identifier && callee.object.name === "Bun";
}

function reachesStateDir(node: TSESTree.Node, scope: TSESLint.Scope.Scope, depth: number): boolean {
  if (depth > MAX_TRACE) return false;
  switch (node.type) {
    case AST_NODE_TYPES.Identifier: {
      if (node.name === "STATE_DIR") return true;
      const def = ASTUtils.findVariable(scope, node)?.defs[0];
      if (def?.type === DefinitionType.Variable && def.node.init) return reachesStateDir(def.node.init, scope, depth + 1);
      if (def?.type === DefinitionType.Parameter && def.name.parent.type === AST_NODE_TYPES.AssignmentPattern) return reachesStateDir(def.name.parent.right, scope, depth + 1);
      return false;
    }
    case AST_NODE_TYPES.TemplateLiteral:
      return node.expressions.some((e) => reachesStateDir(e, scope, depth));
    case AST_NODE_TYPES.CallExpression:
      return node.arguments.some((a) => reachesStateDir(a, scope, depth));
    case AST_NODE_TYPES.BinaryExpression:
      return reachesStateDir(node.left, scope, depth) || reachesStateDir(node.right, scope, depth);
    default:
      return false;
  }
}

export default createRule({
  name: "state-writes-in-state",
  meta: {
    type: "problem",
    docs: { description: "Files under ~/.maxflow-v2 are written only by state.ts" },
    messages: {
      write:
        "Write state through state.ts, not with {{call}} here: a direct write is a non-atomic full rewrite that races every other writer of the file. Use the store's function in state.ts (threadsTable.write, ...), or add one there.",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    if (repoPath(context) === "state.ts") return {};
    return {
      CallExpression(node) {
        const path = node.arguments[0];
        if (!path || !isWrite(node.callee)) return;
        if (reachesStateDir(path, context.sourceCode.getScope(node), 0)) context.report({ node, messageId: "write", data: { call: calleeName(node.callee) } });
      },
    };
  },
});
