import { noSessionEnv } from "../shared/legacy-maxflow";
import { describe, expect, test } from "bun:test";
import { SEED, type Mode } from "../restrictions";
import { ciFrom, mayApprove, mergeHoldWhy } from "../sentries/approval-gate";

const withModes = (modes: Record<string, Mode>) => SEED.map((r) => (modes[r.id] === undefined ? r : { ...r, mode: modes[r.id] ?? r.mode }));
const PR = "dryft-ai/app#12236";

describe("Liudvikas is asked to approve only on green required CI", () => {
  test.each([
    [["pass", "skipping"], "green"],
    [["pass", "pending"], "pending"],
    [["pass", "fail"], "failing"],
    [["pending", "cancel"], "failing"],
    [[], "green"],
  ] as const)("%j is %s", (buckets, ci) => {
    expect(ciFrom([...buckets])).toBe(ci);
  });
});

describe("Liudvikas is asked to approve only when the restrictions allow it", () => {
  test("pr-merge on ask holds the note on the board for Isaac, naming why", () => {
    expect(mergeHoldWhy(PR, withModes({ "pr-merge": "ask" }))).toContain("set to ask");
    expect(mergeHoldWhy(PR, withModes({ "pr-merge": "deny" }))).toContain("set to deny");
    expect(mergeHoldWhy(PR, withModes({ "pr-merge": "allow" }))).toBeUndefined();
  });

  test("pr-approve on allow sends, on deny never does", async () => {
    expect(await mayApprove(PR, withModes({ "pr-approve": "allow" }))).toEqual({ decision: "allow" });
    expect((await mayApprove(PR, withModes({ "pr-approve": "deny" }))).decision).toBe("deny");
  });

  test("pr-approve on ask with no session to ask as is refused, not let through", async () => {
    const was = { ...process.env };
    Object.assign(process.env, noSessionEnv());
    try {
      expect((await mayApprove(PR, withModes({ "pr-approve": "ask" }))).decision).toBe("deny");
    } finally {
      for (const key of Object.keys(noSessionEnv())) process.env[key] = was[key];
    }
  });
});
