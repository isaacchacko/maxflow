import { describe, expect, test } from "bun:test";
import { invalid, matches, resolve, SEED, type Call, type Restriction } from "../restrictions";
import { commandStarts, shellText } from "../restrictions-shell";

const verdict = (command: string) => resolve(SEED, { tool: "Bash", input: { command } });
const hit = (id: string, command: string) => matches(SEED.find((r) => r.id === id)!, { tool: "Bash", input: { command } }, SEED);

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
    expect(hit("pr-merge", "gh pr merge 12 --squash")).toBe(true);
    expect(hit("pr-merge", "cat notes-on-gh pr merge.txt")).toBe(false);
    expect(hit("pr-merge", "echo gh pr merge")).toBe(false);
    expect(hit("pr-merge", "git commit -m 'run gh pr merge later'")).toBe(false);
    expect(hit("push-default", "git push origin master")).toBe(true);
    expect(hit("mallory-phone", "~/.local/bin/mallory send --to umbrella hi")).toBe(true);
    expect(hit("pr-reviewers", "gh pr create --title x --reviewer felix")).toBe(true);
    expect(hit("delete-files", "rm -rf build")).toBe(true);
    expect(hit("delete-files", "cat rm -rf.md")).toBe(false);
  });
});

describe("commandStarts", () => {
  const words = (s: string) => commandStarts(s).map((i) => s.slice(i).split(/[\s;&|()]/)[0]);
  test("first word of each segment, past assignments and keywords", () => {
    expect(words("A=1 git status && cat x | wc -l; if true; then ls; fi")).toEqual(["git", "cat", "wc", "if", "true", "then", "ls", "fi"]);
  });
  test("a path's basename counts", () => expect(words("/usr/bin/pkill x")).toEqual(["/usr/bin/pkill", "pkill"]));
  test("every word after a wrapper counts", () => expect(words("sudo -u me pkill x")).toEqual(["sudo", "-u", "me", "pkill", "x"]));
  test("an inlined script starts its own command", () => expect(shellText("bash -c 'pkill x'")).toContain("; pkill x ;"));
});

describe("the seed catalog", () => {
  const judged = (call: Call, list: Restriction[] = SEED) => {
    const v = resolve(list, call);
    return [v.mode, v.restriction?.id];
  };
  const bash = (command: string, extra: Partial<Call> = {}): Call => ({ tool: "Bash", input: { command }, ...extra });

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

  test("an outsider's PR asks first where a teammate's is allowed", () => {
    const merge = (team: boolean) => judged(bash("gh pr merge 12", { people: [{ github: "someone", team }] }));
    expect(merge(true)).toEqual(["allow", "pr-merge"]);
    expect(merge(false)).toEqual(["ask", "pr-merge-outsiders"]);
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
