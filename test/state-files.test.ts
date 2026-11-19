import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../shared/guards";

const home = mkdtempSync(join(tmpdir(), "maxflow-state-"));
process.env["HOME"] = home;
process.env["MAXFLOW_INSTANCE"] = "statetest";
process.env["MAXFLOW_PORT"] = "1";
const dir = join(home, ".maxflow-v2-statetest");
mkdirSync(dir, { recursive: true });
const { peekStateJson, readGatingStateJson, readStateJson } = await import("../state");

const put = (name: string, text: string) => {
  writeFileSync(join(dir, name), text);
};
const keptCopies = (name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.corrupt-`));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("a valid file reads back, and a missing one reads as undefined", () => {
  put("ok.json", JSON.stringify({ a: 1 }));
  expect(readStateJson("ok.json", isRecord)).toEqual({ a: 1 });
  expect(readStateJson("missing.json", isRecord)).toBeUndefined();
  expect(readGatingStateJson("missing.json", isRecord)).toBeUndefined();
});

test("a file that isn't JSON is kept under a .corrupt- name before its reader starts empty", () => {
  put("broken.json", "{oops");
  expect(readStateJson("broken.json", isRecord)).toBeUndefined();
  const kept = keptCopies("broken.json");
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(dir, kept[0] ?? ""), "utf8")).toBe("{oops");
  expect(readdirSync(dir)).not.toContain("broken.json");
});

test("JSON of the wrong shape is kept the same way", () => {
  put("shape.json", "[1, 2]");
  expect(readStateJson("shape.json", isRecord)).toBeUndefined();
  expect(keptCopies("shape.json")).toHaveLength(1);
});

test("a gating read of a bad file refuses to start and leaves the file where it is", () => {
  put("gate.json", "{oops");
  expect(() => readGatingStateJson("gate.json", isRecord)).toThrow(/won't start with it empty/);
  expect(readFileSync(join(dir, "gate.json"), "utf8")).toBe("{oops");
  expect(keptCopies("gate.json")).toHaveLength(0);
});

test("peeking at another component's bad file changes nothing", () => {
  put("theirs.json", "{oops");
  expect(peekStateJson("theirs.json")).toBeUndefined();
  expect(readFileSync(join(dir, "theirs.json"), "utf8")).toBe("{oops");
});
