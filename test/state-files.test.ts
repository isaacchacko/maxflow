import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "maxflow-state-"));
mkdirSync(join(home, ".maxflow-v2-statetest"), { recursive: true });

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("state files: a bad file is kept and reported, a gating read refuses, and a peek changes nothing", () => {
  const probe = Bun.spawnSync(["bun", join(import.meta.dir, "state-probe.ts")], {
    env: { ...process.env, HOME: home, MAXFLOW_INSTANCE: "statetest", MAXFLOW_PORT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(probe.exitCode).toBe(0);
  const lines = probe.stdout.toString().trim().split("\n");
  const observed: unknown = JSON.parse(lines.at(-1) ?? "{}");
  expect(observed).toMatchObject({
    valid: { a: 1 },
    missing: "undefined",
    gatingMissing: "undefined",
    broken: "undefined",
    brokenKept: 1,
    brokenKeptText: "{oops",
    brokenStillThere: false,
    shape: "undefined",
    shapeKept: 1,
    gateStillThere: true,
    gateKept: 0,
    peek: "undefined",
    theirsStillThere: true,
  });
  expect(observed).toHaveProperty("gatingError", expect.stringContaining("won't start with it empty"));
});
