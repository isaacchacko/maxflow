import { calleeName, createRule, repoPath } from "../rule";

const SYNC = new Set(["spawnSync", "execSync", "execFileSync"]);

export default createRule({
  name: "no-sync-spawn-in-server",
  meta: {
    type: "problem",
    docs: { description: "server.ts never blocks its event loop on a child process" },
    messages: {
      sync: 'server.ts answers every request and websocket on one thread, and a sync spawn freezes all of them until the child exits. Use `await Bun.spawn(argv, { stdout: "pipe" }).exited` and read the output with `await new Response(proc.stdout).text()`.',
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    if (repoPath(context) !== "server.ts") return {};
    return {
      CallExpression(node) {
        if (SYNC.has(calleeName(node.callee))) context.report({ node, messageId: "sync" });
      },
    };
  },
});
