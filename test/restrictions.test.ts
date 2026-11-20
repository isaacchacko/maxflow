import { describe, expect, test } from "bun:test";
import { doesMatch, invalid, resolve, SEED, type Call, type Restriction } from "../restrictions";
import { commandStarts, shellText } from "../restrictions-shell";
import { dirname, join } from "node:path";
import { DIR } from "../instance";

const verdict = (command: string) => resolve(SEED, { tool: "Bash", input: { command } });
function seedNamed(id: string) {
  const restriction = SEED.find((r) => r.id === id);
  if (restriction === undefined) throw new Error(`no seed restriction ${id}`);
  return restriction;
}
const doesHit = (id: string, command: string) => doesMatch(seedNamed(id), { tool: "Bash", input: { command } }, SEED);
const words = (s: string) => commandStarts(s).map((i) => s.slice(i).split(/[\s;&|()]/, 1)[0]);
const judged = (call: Call, list: Restriction[] = SEED) => {
  const v = resolve(list, call);
  return [v.mode, v.restriction?.id];
};
const bash = (command: string, extra: Partial<Call> = {}): Call => ({ tool: "Bash", input: { command }, ...extra });
const mergeByTeammateOrNot = (isTeammate: boolean) => judged(bash("gh pr merge 12", { people: [{ github: "someone", team: isTeammate }] }));

describe("restrictions match command words, not substrings", () => {
  test.each([
    "sed -n 1,20p ~/.claude/projects/x/memory/live-watch-and-pkill.md",
    "cat live-watch-and-pkill.md",
    "grep -n pkill restrictions.ts",
    "echo pkill",
    "git commit -m 'never pkill by pattern'",
    "rg killall docs/",
    "ls ~/notes/killall-notes.md | head",
    "echo $HOME/pkill",
  ])("allows %p", (command) => expect(verdict(command).mode).toBe("allow"));

  test.each([
    "pkill -f bun",
    "/usr/bin/pkill -f bun",
    "sudo pkill bun",
    "FOO=1 pkill bun",
    "cd /tmp && pkill bun",
    "true; killall Chrome",
    "ls | xargs pkill",
    "if pkill bun; then echo ok; fi",
    "echo $(pkill bun)",
    "echo \"$(pkill bun)\"",
    "echo `pkill bun`",
    "bash -c 'pkill -f bun'",
    "ssh cleopatra 'pkill bun'",
    "ssh cleopatra pkill bun",
    "timeout 5 pkill bun",
    "lsof -ti :4949 | xargs kill",
    "bash <<EOF\npkill bun\nEOF",
  ])("denies %p", (command) => expect(verdict(command).mode).toBe("deny"));

  test("other restrictions anchor at the command too", () => {
    expect(doesHit("pr-merge", "gh pr merge 12 --squash")).toBe(true);
    expect(doesHit("pr-merge", "cat notes-on-gh pr merge.txt")).toBe(false);
    expect(doesHit("pr-merge", "echo gh pr merge")).toBe(false);
    expect(doesHit("pr-merge", "git commit -m 'run gh pr merge later'")).toBe(false);
    expect(doesHit("push-default", "git push origin master")).toBe(true);
    expect(doesHit("mallory-phone", "~/.local/bin/mallory send --to umbrella hi")).toBe(true);
    expect(doesHit("pr-reviewers", "gh pr create --title x --reviewer felix")).toBe(true);
    expect(doesHit("gh-poll", "gh run watch 44455340906 --exit-status")).toBe(true);
    expect(doesHit("gh-poll", "timeout -s KILL 900 gh run watch 1 -R isaacchacko/yarn -i 5")).toBe(true);
    expect(doesHit("gh-poll", "gh run watch 1 --interval 30 --exit-status")).toBe(false);
    expect(doesHit("gh-poll", "gh run watch 1 -i=60")).toBe(false);
    expect(doesHit("delete-files", "rm -rf build")).toBe(true);
    expect(doesHit("delete-files", "cat rm -rf.md")).toBe(false);
  });
});

describe("commandStarts", () => {
  test("first word of each segment, past assignments and keywords", () => {
    expect(words("A=1 git status && cat x | wc -l; if true; then ls; fi")).toEqual(["git", "cat", "wc", "if", "true", "then", "ls", "fi"]);
  });
  test("a path's basename counts", () => expect(words("/usr/bin/pkill x")).toEqual(["/usr/bin/pkill", "pkill"]));
  test("every word after a wrapper counts", () => expect(words("sudo -u me pkill x")).toEqual(["sudo", "-u", "me", "pkill", "x"]));
  test("an inlined script starts its own command", () => expect(shellText("bash -c 'pkill x'")).toContain("; pkill x ;"));
});

describe("the seed catalog", () => {
  test("quoted text and data heredocs are data, not commands", () => {
    expect(shellText(`git commit -m "gh pr merge 12"`)).not.toContain("gh pr merge");
    expect(shellText("cat > notes.md <<'EOF'\ngh pr merge 12\nEOF\n")).not.toContain("gh pr merge");
  });

  test("each builtin judges the calls it was written for", () => {
    expect(judged(bash("gh pr review 12 --approve"))).toEqual(["allow", "pr-approve"]);
    expect(judged(bash("gh pr review 12 --comment -b ok"))).toEqual(["allow", "pr-comment"]);
    expect(judged(bash("gh pr create --title x --reviewer felix"))).toEqual(["deny", "pr-reviewers"]);
    expect(judged({ tool: "mcp__claude_ai_Slack__slack_send_message" })).toEqual(["ask", "slack"]);
    expect(judged({ tool: "mcp__claude_ai_Slack__slack_send_message_draft" })).toEqual(["allow", undefined]);
  });

  test("edits under the live checkout are denied, and nothing else is", () => {
    expect(judged({ tool: "Edit", input: { file_path: `${DIR}/server.ts` } })).toEqual(["deny", "edit-live"]);
    expect(judged({ tool: "NotebookEdit", input: { notebook_path: `${DIR}/a.ipynb` } })).toEqual(["deny", "edit-live"]);
    expect(judged({ tool: "Edit", input: { file_path: join(dirname(DIR), "maxflow-v2", "server.ts") } })).toEqual(["deny", "edit-live"]);
    expect(judged({ tool: "Write", input: { file_path: `${DIR}-topic/server.ts` } })).toEqual(["allow", undefined]);
    expect(judged({ tool: "Read", input: { file_path: `${DIR}/server.ts` } })).toEqual(["allow", undefined]);
  });

  test("an outsider's PR asks first where a teammate's is allowed", () => {
    expect(mergeByTeammateOrNot(true)).toEqual(["allow", "pr-merge"]);
    expect(mergeByTeammateOrNot(false)).toEqual(["ask", "pr-merge-outsiders"]);
  });

  test("a call reaching several people gets the strictest verdict", () => {
    const list: Restriction[] = [
      ...SEED,
      { id: "felix", action: "message", label: "Message Felix", mode: "allow", match: {}, parent: "slack", scope: { people: [{ slack: "U1" }] } },
    ];
    const send = (...slack: string[]) => judged({ tool: "mcp__claude_ai_Slack__slack_send_message", people: slack.map((id) => ({ slack: id })) }, list);
    expect(send("U1")).toEqual(["allow", "felix"]);
    expect(send("U1", "U2")).toEqual(["ask", "slack"]);
  });

  test("invalid explains what keeps a restriction from saving", () => {
    expect(invalid({ action: "x", mode: "deny", match: { bash: ["x"] } })).toBe("label required");
    expect(invalid({ label: "x", action: "x", mode: "deny", match: {} })).toBe("match needs a tools or bash regex");
    expect(invalid({ label: "x", action: "x", mode: "deny", match: { bash: ["("] } })).toStartWith("bad regex (");
    expect(invalid({ label: "x", action: "x", mode: "deny", match: { bash: ["x"] } })).toBeUndefined();
  });
});
