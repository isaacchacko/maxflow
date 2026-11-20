import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gateRefusal, isMergeCall, MERGE_REFUSAL, SWITCH_REFUSAL } from "../merge-gate";

const isMergeCommand = (command: string) => isMergeCall("Bash", { command });
const bashCall = (command: string) => ({ command });

describe("the merge gate blocks every way an agent merges", () => {
  test.each([
    "gh pr merge 12 --squash",
    "gh pr merge 12 -R Dryft-AI/app --auto --squash",
    "cd ~/app && gh pr merge 12",
    "timeout 30 gh pr merge 12",
    "/opt/homebrew/bin/gh pr merge 12",
    "bash -c 'gh pr merge 12'",
    "gh api -X PUT repos/Dryft-AI/app/pulls/12/merge",
    "curl -X PUT -H \"Authorization: token $(gh auth token)\" https://api.github.com/repos/Dryft-AI/app/pulls/12/merge",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "gh api -X POST repos/isaacchacko/yarn/merges -f base=master -f head=fix",
    "curl -X POST localhost:4949/api/prs/merge -d '{\"pr\":\"dryft-ai/app#1\"}'",
    "git push origin HEAD:master",
    "git push origin main",
  ])("blocks %s", (command) => {
    expect(isMergeCommand(command)).toBe(true);
  });

  test.each([
    "gh pr view 12",
    "gh pr merge 12 --disable-auto",
    "git commit -m 'leave gh pr merge to Isaac'",
    "grep -n 'gh pr merge' sentries/review.ts",
    "git push origin pr-review",
    "git push origin feat/v2",
    "git merge origin/feat/v2",
    "git rebase origin/main",
    "yarn notify 09ee4563 'the merge button posts to /api/prs/merge'",
  ])("allows %s", (command) => {
    expect(isMergeCommand(command)).toBe(false);
  });

  test("blocks merge tools", () => {
    expect(isMergeCall("mcp__linear__merge_diff", {})).toBe(true);
    expect(isMergeCall("mcp__github__merge_pull_request", {})).toBe(true);
    expect(isMergeCall("mcp__linear__get_diff", {})).toBe(false);
  });
});

describe("the gate is Isaac's switch", () => {
  const on = { on: true, at: 1 };
  const off = { on: false, at: 1 };

  test("on, a merge is refused; off, it goes through to the restrictions", () => {
    expect(gateRefusal({ tool: "Bash", input: bashCall("gh pr merge 12 --squash") }, on)).toBe(MERGE_REFUSAL);
    expect(gateRefusal({ tool: "Bash", input: bashCall("gh pr merge 12 --squash") }, off)).toBeUndefined();
    expect(gateRefusal({ tool: "Bash", input: bashCall("gh pr view 12") }, on)).toBeUndefined();
  });

  test.each([
    ["Bash", bashCall("echo '{\"on\":false}' > ~/.maxflow-v2/merge-gate.json")],
    ["Bash", bashCall("rm ~/.maxflow-v2/merge-gate.json")],
    ["Bash", bashCall("curl -X POST localhost:4949/api/merge-gate -d '{\"on\":true}'")],
    ["Write", { file_path: "/Users/isaac/.maxflow-v2/merge-gate.json", content: "{}" }],
  ])("no agent flips it either way: %s %p", (tool, input) => {
    expect(gateRefusal({ tool, input }, off)).toBe(SWITCH_REFUSAL);
    expect(gateRefusal({ tool, input }, on)).toBe(SWITCH_REFUSAL);
  });

  test("~/Timelines pushes to main with the gate on: it has no PRs", () => {
    expect(gateRefusal({ tool: "Bash", input: bashCall("git push origin main"), cwd: "/Users/isaac/Timelines" }, on)).toBeUndefined();
    expect(gateRefusal({ tool: "Bash", input: bashCall("cd ~/Timelines && git push origin main") }, on)).toBeUndefined();
    expect(gateRefusal({ tool: "Bash", input: bashCall("git push origin main"), cwd: "/Users/isaac/app" }, on)).toBe(MERGE_REFUSAL);
    expect(gateRefusal({ tool: "Bash", input: bashCall("gh pr merge 3"), cwd: "/Users/isaac/Timelines" }, on)).toBe(MERGE_REFUSAL);
  });

  test("an agent may read it", () => {
    expect(gateRefusal({ tool: "Bash", input: bashCall("curl -s localhost:$MAXFLOW_PORT/api/merge-gate") }, on)).toBeUndefined();
  });

  test("the review feed merges only behind the gate", () => {
    const text = readFileSync(new URL("../sentries/review.ts", import.meta.url), "utf8");
    expect(text).toContain("if (isGateOn || isCiFailing(ciOf(pr)) || pr.autoMergeRequest) return;");
  });
});

describe("no other sentry merges", () => {
  test.each(["sentries/approval.ts", "sentries/approval-notify.ts", "sentries/gh.ts"])("%s never merges or arms auto-merge", (file) => {
    const text = (() => {
      try {
        return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      } catch {
        return "";
      }
    })();
    expect(text).not.toMatch(/"--auto"|"--squash"|"--rebase"|enablePullRequestAutoMerge|mergePullRequest|\/pulls\/[^"]*\/merge/);
    const merges = text.matchAll(/\["pr",\s*"merge"[^\]]*\]/g).map((m) => m[0]).toArray();
    expect(merges.every((m) => m.includes("--disable-auto"))).toBe(true);
  });
});
