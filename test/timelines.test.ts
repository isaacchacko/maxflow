import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["MAXFLOW_TIMELINES"] = join(mkdtempSync(join(tmpdir(), "maxflow-timelines-")), "Timelines");
process.env["MAXFLOW_TIMELINES_REMOTE"] = "";
const t = await import("../timelines");
t.ensureTimelines();

const AT = new Date("2026-11-20T18:04:05.123Z");

test("an event is one file named by its UTC time and a filename-safe title", () => {
  const file = t.addEvent("maxflow/merge-gate", "PR #12 up: gate/merge", "opened it", AT);
  expect(file).toBe("maxflow/merge-gate/2026-11-20T18-04-05Z PR #12 up gate merge.txt");
  expect(readFileSync(join(t.TIMELINES_DIR, file), "utf8")).toBe("opened it\n");
  expect(t.addEvent("maxflow/merge-gate", "PR #12 up: gate/merge", "again", AT)).toEndWith(" merge 2.txt");
});

test("read gives now.txt and the latest events in time order", () => {
  t.addEvent("maxflow/merge-gate", "merged", "done", new Date("2026-11-21T00:00:00Z"));
  t.setNow("maxflow/merge-gate", "shipped");
  const read = t.readTimeline("maxflow/merge-gate", 2);
  expect(read.now).toBe("shipped\n");
  expect(read.total).toBe(3);
  expect(read.events.map((e) => e.text)).toEqual(["again\n", "done\n"]);
});

test("ls finds timelines at any depth, find matches every word", () => {
  t.setNow("dryft/app/priority-queue", "waiting on review");
  expect(t.listTimelines().map((x) => x.path)).toEqual(["dryft/app/priority-queue", "maxflow/merge-gate"]);
  expect(t.listTimelines("dryft").map((x) => x.events)).toEqual([0]);
  expect(t.findEvents(["GATE", "opened"]).map((h) => h.file)).toEqual(["maxflow/merge-gate/2026-11-20T18-04-05Z PR #12 up gate merge.txt"]);
});

test("a path outside the folder or into .git is refused", () => {
  expect(() => t.addEvent("../escape", "x", "y")).toThrow();
  expect(() => t.setNow(".git/hooks", "y")).toThrow();
});

test("every edit, by hand or not, lands in a commit", () => {
  writeFileSync(join(t.TIMELINES_DIR, "maxflow/merge-gate/now.txt"), "rewritten by hand\n");
  expect(t.didCommit("hand edit")).toBe(true);
  expect(t.uncommitted()).toEqual([]);
  expect(t.didCommit("nothing new")).toBe(false);
});
