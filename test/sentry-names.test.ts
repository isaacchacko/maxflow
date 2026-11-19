import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BARE_AGENT_SENTRIES, FED_AGENT_SENTRIES, PLAIN_SENTRIES, SENTRY_HELPERS, SENTRY_NAMES } from "../sentry-names";

const root = join(import.meta.dir, "..");
const scripts = readdirSync(join(root, "sentries")).filter((f) => f.endsWith(".ts")).map((f) => basename(f, ".ts"));

test("every script under sentries/ is a sentry server.ts starts or a listed helper", () => {
  const known = new Set([...PLAIN_SENTRIES, ...FED_AGENT_SENTRIES, ...SENTRY_HELPERS]);
  expect(scripts.filter((s) => !known.has(s))).toEqual([]);
  expect([...known].filter((s) => !scripts.includes(s))).toEqual([]);
  expect([...FED_AGENT_SENTRIES, ...BARE_AGENT_SENTRIES].filter((s) => !existsSync(join(root, "sentries", `${s}.md`)))).toEqual([]);
});

test("server.ts and sentry-commands.ts build SENTRIES from sentry-names.ts alone", () => {
  const server = readFileSync(join(root, "server.ts"), "utf8");
  expect(server).not.toContain('SENTRIES["sentry:');
  expect(server).toContain('from "./sentry-names"');
  expect(readFileSync(join(root, "sentry-commands.ts"), "utf8")).toContain("PLAIN_SENTRIES");
});

test("every sentry has a SENTRY_USES description, and every description a sentry", () => {
  const home = mkdtempSync(join(tmpdir(), "sentry-names-"));
  try {
    const read = Bun.spawnSync(["bun", "-e", 'console.log(JSON.stringify(Object.keys((await import("./world")).SENTRY_USES))); process.exit(0)'], {
      cwd: root,
      env: { ...process.env, HOME: home, MAXFLOW_INSTANCE: "sentry-names", MAXFLOW_PORT: "1" },
    });
    const described = JSON.parse(read.stdout.toString()) as string[];
    expect(SENTRY_NAMES.filter((n) => !described.includes(n))).toEqual([]);
    expect(described.filter((n) => !SENTRY_NAMES.includes(n))).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
