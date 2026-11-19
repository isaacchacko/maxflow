import { relative, sep } from "node:path";
import { AST_NODE_TYPES, ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";

export const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/isaacchacko/maxflow/blob/feat/v2/lint/rules/${name}.ts`);

export type Area = "src" | "shared" | "sentries" | "hooks" | "scripts" | "test" | "fixtures" | "lint" | "root";
const AREAS = new Set<string>(["src", "shared", "sentries", "hooks", "scripts", "test", "fixtures", "lint"]);

export function repoPath(context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>, file = context.filename) {
  return relative(context.cwd, file).split(sep).join("/");
}

export function areaOf(path: string): Area {
  const top = path.split("/", 1)[0] ?? "";
  return path.includes("/") && AREAS.has(top) ? (top as Area) : "root";
}

export function calleeName(callee: TSESTree.Expression) {
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name;
  return callee.type === AST_NODE_TYPES.MemberExpression && callee.property.type === AST_NODE_TYPES.Identifier ? callee.property.name : "";
}
