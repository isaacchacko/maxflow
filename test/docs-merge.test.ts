import { expect, test } from "bun:test";
import { ChangeSet, Text } from "@codemirror/state";
import { diff } from "../src/views/docs/session";

const BASE = "We ship on Friday.\n\nSteps:\n1. hooks\n";

test("diff turns one text into another as a single change", () => {
  const after = BASE.replace("Friday", "Thursday");
  expect(diff(BASE, after).apply(Text.of(BASE.split("\n"))).toString()).toBe(after);
  expect(diff(BASE, BASE).empty).toBe(true);
});

test("an agent's edit and his unsaved typing on the same base both survive", () => {
  const mine = ChangeSet.of({ from: BASE.length, insert: "2. deploy\n" }, BASE.length);
  const theirs = diff(BASE, BASE.replace("Friday", "Thursday"));
  const merged = mine.map(theirs, true).apply(theirs.apply(Text.of(BASE.split("\n"))));
  expect(merged.toString()).toBe("We ship on Thursday.\n\nSteps:\n1. hooks\n2. deploy\n");
});
