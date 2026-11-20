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

function initialValueOf(identifier: TSESTree.Identifier, scope: TSESLint.Scope.Scope): TSESTree.Node | null | undefined {
  const def = ASTUtils.findVariable(scope, identifier)?.defs[0];
  if (def?.type === DefinitionType.Variable) return def.node.init;
  if (def?.type === DefinitionType.Parameter && def.name.parent.type === AST_NODE_TYPES.AssignmentPattern) return def.name.parent.right;
  return undefined;
}

function partsOf(node: TSESTree.Node): readonly TSESTree.Node[] {
  if (node.type === AST_NODE_TYPES.TemplateLiteral) return node.expressions;
  if (node.type === AST_NODE_TYPES.CallExpression) return node.arguments;
  if (node.type === AST_NODE_TYPES.BinaryExpression) return [node.left, node.right];
  return [];
}

const isStateDisplayPath = (node: TSESTree.Node) => node.type === AST_NODE_TYPES.CallExpression && calleeName(node.callee) === "stateDisplayPath";

function doesAnyPartReachStateDir(node: TSESTree.Node, scope: TSESLint.Scope.Scope, depth: number) {
  return isStateDisplayPath(node) || partsOf(node).some((part) => doesReachStateDir(part, scope, depth));
}

function doesReachStateDir(start: TSESTree.Node, scope: TSESLint.Scope.Scope, startDepth: number): boolean {
  let node: TSESTree.Node | null | undefined = start;
  for (let depth = startDepth; node && depth <= MAX_TRACE; depth += 1) {
    if (node.type !== AST_NODE_TYPES.Identifier) return doesAnyPartReachStateDir(node, scope, depth);
    if (node.name === "STATE_DIR") return true;
    node = initialValueOf(node, scope);
  }
  return false;
}

export default createRule({
  name: "state-writes-in-state",
  meta: {
    type: "problem",
    docs: { description: "Files under ~/.yarn-v2 are written only by state.ts" },
    messages: {
      write:
        "Write state through state.ts, not with {{call}} here: a direct write is a non-atomic full rewrite that races every other writer of the file. Use state.ts: the store's table (threadsTable.write, ...), or writeStateJson (atomic: temp file, then rename), appendStateText or removeState for a file that stays a file.",
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
        if (doesReachStateDir(path, context.sourceCode.getScope(node), 0)) context.report({ node, messageId: "write", data: { call: calleeName(node.callee) } });
      },
    };
  },
});
