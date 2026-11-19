import { dirname, join, normalize } from "node:path";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { type Area, areaOf, createRule, repoPath } from "../rule";

type MessageId = "srcOut" | "intoSrc" | "server" | "intoSentries" | "intoTooling" | "lint";

function target(fromFile: string, specifier: string) {
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}`;
  if (!specifier.startsWith(".")) return undefined;
  return normalize(join(dirname(fromFile), specifier)).split("\\").join("/");
}

const TOOLING = new Set<Area>(["test", "scripts", "fixtures"]);

function violation(fromPath: string, from: Area, to: Area, toPath: string): MessageId | undefined {
  if (from === "src") return to === "src" || to === "shared" ? undefined : "srcOut";
  if (to === "src") return toPath.endsWith(".html") && from === "root" ? undefined : "intoSrc";
  if (from === "test") return undefined;
  if (/^server(\.ts)?$/.test(toPath)) return "server";
  if (to === "sentries" && from !== "sentries") return "intoSentries";
  if (TOOLING.has(to) && from !== to && from !== "scripts") return "intoTooling";
  if ((to === "lint") !== (from === "lint") && fromPath !== "eslint.config.ts") return "lint";
  return undefined;
}

export default createRule({
  name: "import-boundaries",
  meta: {
    type: "problem",
    docs: { description: "Keep the browser bundle, the server, the sentries and the tooling from importing each other" },
    messages: {
      srcOut:
        "src/ is the browser bundle: it may import only src/ and shared/. Move what both sides need (types, pure helpers with no node: or Bun imports) into shared/ and import it from there.",
      intoSrc: 'Only server.ts\'s `import app from "./src/index.html"` reaches into src/. Move what the server and the UI share into shared/.',
      server:
        "server.ts is the process entry, not a library: importing it starts a second server. Move what you need into its own module and import that from both.",
      intoSentries:
        "A sentry file is a process of its own. Move the helpers you need out of it into a root module that both the sentry and you import.",
      intoTooling: "Runtime code never imports test/, scripts/ or fixtures/: they import the runtime, not the other way round.",
      lint: "lint/ is the linter's plugin: it and the app don't import each other.",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    const from = repoPath(context);
    const check = (source: TSESTree.Node | null | undefined) => {
      if (source?.type !== AST_NODE_TYPES.Literal || typeof source.value !== "string") return;
      const to = target(from, source.value);
      if (to === undefined) return;
      const messageId = violation(from, areaOf(from), areaOf(to), to);
      if (messageId) context.report({ node: source, messageId });
    };
    return {
      ImportDeclaration: (node) => {
        check(node.source);
      },
      ExportNamedDeclaration: (node) => {
        check(node.source);
      },
      ExportAllDeclaration: (node) => {
        check(node.source);
      },
      ImportExpression: (node) => {
        check(node.source);
      },
    };
  },
});
