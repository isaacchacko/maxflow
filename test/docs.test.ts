import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["MAXFLOW_DOCS"] = mkdtempSync(join(tmpdir(), "maxflow-docs-"));
const docs = await import("../docs");

const DOC = `---
owner: abc123
---
# Plan

Ship it Friday.

> [!comment]
> Make this sooner.
> > [!reply] docs agent
> > Moved to Thursday.

> [!comment] isaac
> Who signs off?

> [!note]
> not a comment
`;

test("a thread is open while Isaac has the last word", () => {
  const [answered, asked] = docs.commentsIn(DOC);
  expect(answered).toEqual({ line: 8, isOpen: false, entries: [{ who: "isaac", text: "Make this sooner." }, { who: "docs agent", text: "Moved to Thursday." }] });
  expect(asked).toEqual({ line: 13, isOpen: true, entries: [{ who: "isaac", text: "Who signs off?" }] });
  expect(docs.commentsIn(DOC)).toHaveLength(2);
});

test("a comment shown as an example in a code block is not one", () => {
  expect(docs.commentsIn("```\n> [!comment]\n> example\n```\n")).toEqual([]);
});

test("owner comes from frontmatter, and is added only where missing", () => {
  expect(docs.ownerOf(DOC)).toBe("abc123");
  expect(docs.withOwner(DOC, "zzz")).toBe(DOC);
  expect(docs.withOwner("# hi\n", "zzz")).toBe("---\nowner: zzz\n---\n# hi\n");
  expect(docs.ownerOf(docs.withOwner("---\ntitle: x\n---\nbody", "zzz"))).toBe("zzz");
});

test("paths stay inside the vault", () => {
  expect(docs.docPath("notes/plan")).toBe("notes/plan.md");
  expect(() => docs.docPath("../etc/passwd")).toThrow();
  expect(() => docs.docPath(".git/config")).toThrow();
});

test("writes, moves and removes are each a commit by the agent", () => {
  docs.ensureVault();
  docs.writeDoc("a/plan", DOC, "docs agent");
  docs.moveDoc("a/plan", "b/plan", "docs agent");
  expect(docs.listDocs()).toEqual([{ path: "b/plan.md", owner: "abc123", open: 1 }]);
  docs.removeDoc("b/plan", "docs agent");
  const log = Bun.spawnSync(["git", "log", "--format=%an|%s"], { cwd: docs.DOCS_DIR }).stdout.toString().trim().split("\n");
  expect(log.slice(0, 3)).toEqual(["docs agent|docs agent: remove b/plan.md", "docs agent|docs agent: move a/plan.md to b/plan.md", "docs agent|docs agent: write a/plan.md"]);
  expect(docs.uncommitted()).toEqual([]);
});
