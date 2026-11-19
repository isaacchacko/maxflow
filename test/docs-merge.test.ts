import { expect, test } from "bun:test";
import { ChangeSet, Text } from "@codemirror/state";
import { diff } from "../src/views/docs/session";

const BASE = "We ship on Friday.\n\nSteps:\n1. hooks\n";

test("diff turns one text into another as a single change", () => {
  const after = BASE.replace("Friday", "Thursday");
  const base = Text.of(BASE.split("\n"));
  expect(diff(BASE, after).apply(base).toString()).toBe(after);
  expect(diff(BASE, BASE).empty).toBe(true);
});

test("an agent's edit and his unsaved typing on the same base both survive", () => {
  const mine = ChangeSet.of({ from: BASE.length, insert: "2. deploy\n" }, BASE.length);
  const theirs = diff(BASE, BASE.replace("Friday", "Thursday"));
  const theirsText = theirs.apply(Text.of(BASE.split("\n")));
  const merged = mine.map(theirs, true).apply(theirsText);
  expect(merged.toString()).toBe("We ship on Thursday.\n\nSteps:\n1. hooks\n2. deploy\n");
});
