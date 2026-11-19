import { describe, expect, test } from "bun:test";
import { matches, resolve, SEED } from "../restrictions";
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
