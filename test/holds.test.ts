import { noSessionEnv } from "../shared/legacy-maxflow";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prKeyOf } from "../holds";

const root = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "yarn-holds-"));
const stateDir = join(home, ".maxflow-v2-holdstest");
mkdirSync(stateDir, { recursive: true });
const env = { ...process.env, HOME: home, YARN_INSTANCE: "holdstest", YARN_PORT: "1", ...noSessionEnv() };

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const cli = (...args: string[]) => Bun.spawnSync(["bun", join(root, "cli.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
const heldOn = (key: string) =>
  Bun.spawnSync(["bun", "-e", `import { holdOn } from "./holds"; console.log(JSON.stringify(holdOn(${JSON.stringify(key)}) ?? null))`], { cwd: root, env, stdout: "pipe" }).stdout.toString().trim();

const here = () => "Dryft-AI/app";

test("a PR ref resolves to the sentries' owner/repo#n key, from a url, a key or a bare number", () => {
  expect(prKeyOf("https://github.com/Dryft-AI/app/pull/12236/files", here)).toBe("dryft-ai/app#12236");
  expect(prKeyOf("Dryft-AI/app#12236", here)).toBe("dryft-ai/app#12236");
  expect(prKeyOf("#12236", here)).toBe("dryft-ai/app#12236");
  expect(prKeyOf("not-a-pr", here)).toBeUndefined();
});

test("hold, holds and unhold stand the sentries down on one PR and back up", () => {
  expect(cli("hold", "Dryft-AI/app#12236", "Isaac", "said", "stand", "down")).toContain("held dryft-ai/app#12236");
  expect(JSON.parse(heldOn("dryft-ai/app#12236"))).toMatchObject({ by: "isaac", why: "Isaac said stand down" });
  expect(heldOn("dryft-ai/app#1")).toBe("null");
  expect(cli("holds")).toContain("dryft-ai/app#12236");
  expect(cli("unhold", "https://github.com/Dryft-AI/app/pull/12236")).toBe("unheld dryft-ai/app#12236");
  expect(heldOn("dryft-ai/app#12236")).toBe("null");
});

test("an unreadable holds file holds every PR instead of none", () => {
  writeFileSync(join(stateDir, "pr-holds.json"), "{oops");
  expect(JSON.parse(heldOn("dryft-ai/app#7"))).toMatchObject({ by: "yarn" });
});
