import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { calleeName, createRule } from "../rule";

const KILL = /(^|[\s/;&|`(])(pkill|killall)(\s|$)|xargs\s+(-\S+\s+)*kill\b/;
const SPAWNS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);

function text(node: TSESTree.Node): string {
  if (node.type === AST_NODE_TYPES.Literal) return typeof node.value === "string" ? node.value : "";
  if (node.type === AST_NODE_TYPES.TemplateLiteral) return node.quasis.map((q) => q.value.cooked ?? "").join(" ");
  if (node.type === AST_NODE_TYPES.ArrayExpression) return node.elements.map((e) => (e && e.type !== AST_NODE_TYPES.SpreadElement ? text(e) : "")).join(" ");
  return "";
}

export default createRule({
  name: "no-kill-by-pattern",
  meta: {
    type: "problem",
    docs: { description: "Never kill processes by name or pattern" },
    messages: {
      kill: "Never kill by name or pattern: pkill, killall and `xargs kill` match the live maxflow, other agents' work and Isaac's Chrome. Keep the Subprocess you started and call its .kill(), kill the one pid you own, or stop a dev instance with ./dev.sh stop <instance>.",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const first = node.arguments[0];
        if (first && SPAWNS.has(calleeName(node.callee)) && KILL.test(text(first))) context.report({ node, messageId: "kill" });
      },
      TaggedTemplateExpression(node) {
        if (node.tag.type === AST_NODE_TYPES.Identifier && node.tag.name === "$" && KILL.test(text(node.quasi))) context.report({ node, messageId: "kill" });
      },
    };
  },
});
