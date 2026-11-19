import { join } from "node:path";
import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { yarn } from "../lint/plugin";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const at = (path: string) => join(process.cwd(), path);
const rule = (name: keyof typeof yarn.rules) => yarn.rules[name] as unknown as Parameters<RuleTester["run"]>[1];

tester.run("no-comments", rule("no-comments"), {
  valid: [
    "#!/usr/bin/env bun\nconst a = 1;",
    "// constraint: GitHub's API caps per_page at 100\nconst a = 1;",
    "// eslint-disable-next-line no-console -- the CLI prints\nconsole.info(1);",
    "/// <reference types=\"bun\" />\nconst a = 1;",
  ],
  invalid: [
    { code: "// increments a\nlet a = 1; a += 1;", errors: [{ messageId: "comment" }] },
    { code: "/** Docs */\nconst a = 1;", errors: [{ messageId: "comment" }] },
    { code: "// constraint: one\n// constraint: two\nconst a = 1;", errors: [{ messageId: "stacked" }] },
    { code: `// constraint: ${"x".repeat(170)}\nconst a = 1;`, errors: [{ messageId: "long" }] },
  ],
});

tester.run("import-boundaries", rule("import-boundaries"), {
  valid: [
    { code: 'import { a } from "./lib/x";', filename: at("src/App.tsx") },
    { code: 'import { a } from "@/lib/x";', filename: at("src/App.tsx") },
    { code: 'import app from "./src/index.html";', filename: at("server.ts") },
    { code: 'import { a } from "../instance";', filename: at("sentries/gh.ts") },
    { code: 'import { a } from "../server";', filename: at("test/boot.test.ts") },
    { code: 'const { a } = await import("../src/lib/effects");', filename: at("test/effects.test.tsx") },
  ],
  invalid: [
    { code: 'import type { R } from "../../restrictions";', filename: at("src/views/R.tsx"), errors: [{ messageId: "srcOut" }] },
    { code: 'import { a } from "./src/store";', filename: at("cli.ts"), errors: [{ messageId: "intoSrc" }] },
    { code: 'import { a } from "../server";', filename: at("sentries/gh.ts"), errors: [{ messageId: "server" }] },
    { code: 'import { a } from "./sentries/gh";', filename: at("cli.ts"), errors: [{ messageId: "intoSentries" }] },
    { code: 'import { a } from "./fixtures/seed";', filename: at("server.ts"), errors: [{ messageId: "intoTooling" }] },
  ],
});

tester.run("state-dir-in-state", rule("state-dir-in-state"), {
  valid: [{ code: 'import { STATE_DIR } from "./instance";', filename: at("state.ts") }],
  invalid: [{ code: 'import { STATE_DIR } from "./instance";', filename: at("bus.ts"), errors: [{ messageId: "stateDir" }] }],
});

tester.run("state-writes-in-state", rule("state-writes-in-state"), {
  valid: [
    { code: 'import { writeFileSync } from "node:fs"; writeFileSync("/tmp/x", "");', filename: at("bus.ts") },
    { code: 'const F = join(STATE_DIR, "a.json"); writeFileSync(F, "");', filename: at("state.ts") },
  ],
  invalid: [
    { code: 'const F = join(STATE_DIR, "a.json"); writeFileSync(F, "");', filename: at("sentries/gh.ts"), errors: [{ messageId: "write" }] },
    { code: "Bun.write(`${STATE_DIR}/a.json`, \"\");", filename: at("bus.ts"), errors: [{ messageId: "write" }] },
    { code: 'function save(dir = STATE_DIR) { appendFileSync(join(dir, "x"), ""); }', filename: at("bus.ts"), errors: [{ messageId: "write" }] },
    { code: 'writeFileSync(stateDisplayPath("x.json"), "");', filename: at("bus.ts"), errors: [{ messageId: "write" }] },
  ],
});

tester.run("no-kill-by-pattern", rule("no-kill-by-pattern"), {
  valid: ['Bun.spawn(["kill", String(pid)]);', 'Bun.spawn(["grep", "pkill.md"]);'],
  invalid: [
    { code: 'Bun.spawn(["pkill", "-f", "bun"]);', errors: [{ messageId: "kill" }] },
    { code: 'Bun.spawnSync(["sh", "-c", "lsof -ti :4949 | xargs kill"]);', errors: [{ messageId: "kill" }] },
    { code: "$`killall Chrome`;", errors: [{ messageId: "kill" }] },
  ],
});

tester.run("fetch-needs-timeout", rule("fetch-needs-timeout"), {
  valid: [
    { code: "fetch(url, { signal: AbortSignal.timeout(5000) });", filename: at("bus.ts") },
    { code: "fetch(url);", filename: at("src/live.ts") },
  ],
  invalid: [
    { code: "fetch(url);", filename: at("sentries/gh.ts"), errors: [{ messageId: "timeout" }] },
    { code: 'fetch(url, { method: "POST" });', filename: at("cli.ts"), errors: [{ messageId: "timeout" }] },
  ],
});

tester.run("no-sync-spawn-in-server", rule("no-sync-spawn-in-server"), {
  valid: [{ code: 'Bun.spawnSync(["ls"]);', filename: at("cli.ts") }],
  invalid: [{ code: 'Bun.spawnSync(["ls"]);', filename: at("server.ts"), errors: [{ messageId: "sync" }] }],
});
