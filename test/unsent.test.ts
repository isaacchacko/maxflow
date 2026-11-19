import { expect, test } from "bun:test";
import { unsentCount } from "../unsent";

const three = '[maxflow] Your wait on agent:05a2db54 is over.\n[maxflow · from "PR 12867" (41418832)] #12867 report.\n[maxflow] Your wait on agent:41418832 is over.';

test("a collapsed paste is ours when its line count matches the first inbox messages joined", () => {
  // Router 17656f41's prompt on 2026-11-19: one inbox entry of three lines, shown as +2 lines.
  expect(unsentCount([three], "[Pasted text #1 +2 lines]")).toBe(1);
  expect(unsentCount(["[maxflow] a\nb", "[maxflow] c", "[maxflow] d"], "[Pasted text #1 +2 lines]")).toBe(2);
  expect(unsentCount(["[maxflow] a\nb", "[maxflow] c"], "[Pasted text #3 +1 line]")).toBe(1);
});

test("a collapsed paste with another line count is his, and stays", () => {
  expect(unsentCount([three], "[Pasted text #1 +40 lines]")).toBe(0);
  expect(unsentCount([], "[Pasted text #1 +2 lines]")).toBe(0);
  expect(unsentCount([three], "fix this [Pasted text #1 +2 lines]")).toBe(0);
});

test("a paste shown as typed is ours when it starts with the stamp, and counts the messages it holds", () => {
  expect(unsentCount(["[maxflow] one", "[maxflow] two"], "[maxflow] one\n  [maxflow] two")).toBe(2);
  // Wrapped mid-word at the pane's edge.
  expect(unsentCount(["[maxflow] a long message", "[maxflow] more"], "[maxflow] a long mes\n  sage")).toBe(1);
  expect(unsentCount(["[maxflow] one"], "my own draft")).toBe(0);
  expect(unsentCount([], "[maxflow] one")).toBe(0);
});
