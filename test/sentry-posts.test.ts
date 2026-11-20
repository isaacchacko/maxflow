import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "maxflow-sentry-posts-"));
mkdirSync(join(home, ".maxflow-v2-sentrypoststest"), { recursive: true });
const env = { ...process.env, HOME: home, MAXFLOW_INSTANCE: "sentrypoststest", MAXFLOW_PORT: "1" };

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const probe = `
import { recordSentryPost, sentryThatPosted } from "./sentry-posts";
recordSentryPost("approval", 3141592);
console.log(JSON.stringify([
  sentryThatPosted("https://github.com/Dryft-AI/app/pull/12236#issuecomment-3141592") ?? null,
  sentryThatPosted("https://github.com/Dryft-AI/app/pull/12236#issuecomment-2718281") ?? null,
  sentryThatPosted(undefined) ?? null,
]));`;

test("a comment the approval sentry posted under Isaac's login is known as the sentry's, and his own comments aren't", () => {
  const out = Bun.spawnSync(["bun", "-e", probe], { cwd: root, env, stdout: "pipe" }).stdout.toString().trim();
  expect(JSON.parse(out)).toEqual(["approval", null, null]);
});
