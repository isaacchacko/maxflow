import { expect, test } from "bun:test";
import { unsentCount } from "../unsent";

const three = '[yarn] Your wait on agent:05a2db54 is over.\n[yarn · from "PR 12867" (41418832)] #12867 report.\n[yarn] Your wait on agent:41418832 is over.';

test("router 17656f41's prompt on 2026-11-19: one inbox entry of three lines, collapsed as +2 lines, is ours", () => {
  expect(unsentCount([three], "[Pasted text #1 +2 lines]")).toBe(1);
});

test("a collapsed paste is ours when its line count matches the first inbox messages joined", () => {
  expect(unsentCount(["[yarn] a\nb", "[yarn] c", "[yarn] d"], "[Pasted text #1 +2 lines]")).toBe(2);
  expect(unsentCount(["[yarn] a\nb", "[yarn] c"], "[Pasted text #3 +1 line]")).toBe(1);
});

test("a collapsed paste with another line count is his, and stays", () => {
  expect(unsentCount([three], "[Pasted text #1 +40 lines]")).toBe(0);
  expect(unsentCount([], "[Pasted text #1 +2 lines]")).toBe(0);
  expect(unsentCount([three], "fix this [Pasted text #1 +2 lines]")).toBe(0);
});

test("a paste shown as typed is ours when it starts with the stamp, and counts the messages it holds", () => {
  expect(unsentCount(["[yarn] one", "[yarn] two"], "[yarn] one\n  [yarn] two")).toBe(2);
  expect(unsentCount(["[yarn] one"], "my own draft")).toBe(0);
  expect(unsentCount([], "[yarn] one")).toBe(0);
});

test("a typed paste wrapped mid-word at the pane's edge still counts as ours", () => {
  expect(unsentCount(["[yarn] a long message", "[yarn] more"], "[yarn] a long mes\n  sage")).toBe(1);
});
