import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeText } from "../shared/merge-text";

process.env["MAXFLOW_DOCS"] ??= mkdtempSync(join(tmpdir(), "maxflow-canvas-"));
const canvas = await import("../canvas");
const { DOCS_DIR } = await import("../docs");

// constraint: bun test shares one docs module, and so one vault, across test files
const HERE = "canvas-test";
afterAll(() => rmSync(join(DOCS_DIR, HERE), { recursive: true, force: true }));

test("edits to different parts of a box both land; edits to the same part conflict", () => {
  expect(mergeText("the cat sat", "the big cat sat", "the cat sat down")).toBe("the big cat sat down");
  expect(mergeText("the cat sat", "the cat sat", "the dog sat")).toBe("the dog sat");
  expect(mergeText("the cat sat", "the cow sat", "the dog sat")).toBeUndefined();
});

test("boxes are added, edited, linked and deleted one at a time, and the file is JSON Canvas", () => {
  const { path } = canvas.createCanvas(`${HERE}/plans/board`);
  expect(path).toBe(`${HERE}/plans/board.canvas`);
  const a = canvas.addNode(path, { text: "Why is the deploy slow?", x: 10, y: 20 }, "isaac");
  const b = canvas.addNode(path, { text: "Because of the build", x: 400, y: 20 }, "agent1");
  canvas.linkNode(path, a.id, { text: "deploy", to: b.id }, "agent1");
  expect(canvas.readCanvas(path).canvas.nodes[0]?.text).toBe(`Why is the [deploy](#${b.id}) slow?`);
  expect(() => canvas.linkNode(path, a.id, { text: "deploy", to: b.id }, "agent1")).toThrow();

  const edited = canvas.editNode(path, a.id, { text: "Why is the deploy so slow?", base: "Why is the deploy slow?" }, "isaac");
  expect(edited.text).toBe(`Why is the [deploy](#${b.id}) so slow?`);
  expect(canvas.editNode(path, a.id, { x: 50 }, "agent1")).toMatchObject({ x: 50, y: 20, author: "isaac" });

  canvas.removeNode(path, b.id);
  const file = JSON.parse(readFileSync(join(DOCS_DIR, path), "utf8")) as { nodes: { text: string }[] };
  expect(file.nodes.map((n) => n.text)).toEqual(["Why is the deploy so slow?"]);
});

test("an edit made outside the server, as in Obsidian, is picked up", () => {
  const { path } = canvas.createCanvas(`${HERE}/outside`);
  writeFileSync(join(DOCS_DIR, path), JSON.stringify({ nodes: [{ id: "n1", type: "text", text: "hi", x: 0, y: 0, width: 100, height: 50 }], edges: [] }));
  expect(canvas.readCanvas(path).canvas.nodes.map((n) => n.id)).toEqual(["n1"]);
});

test("a phrase that appears twice links the occurrence nearest the selection", () => {
  const { path } = canvas.createCanvas(`${HERE}/twice`);
  const a = canvas.addNode(path, { text: "cache here, cache there" }, "isaac");
  const b = canvas.addNode(path, { text: "target" }, "isaac");
  expect(canvas.linkNode(path, a.id, { text: "cache", to: b.id, near: 14 }, "isaac").text).toBe(`cache here, [cache](#${b.id}) there`);
});

test("an agent can't replace a box Isaac is typing in, but its find/replace and append merge with his typing", () => {
  const { path } = canvas.createCanvas(`${HERE}/typing`);
  const box = canvas.addNode(path, { text: "Build is slow" }, "isaac");
  canvas.markTyping(path, box.id);
  canvas.editNode(path, box.id, { text: "Build is slow (isaac typing", base: "Build is slow" }, "isaac");
  expect(() => canvas.editNode(path, box.id, { text: "AGENT. Build is slow" }, "agent1")).toThrow(/typing/);
  canvas.editNode(path, box.id, { find: "Build", replace: "AGENT. Build" }, "agent1");
  canvas.editNode(path, box.id, { append: "agent: measured 6 min" }, "agent1");
  const mine = canvas.editNode(path, box.id, { text: "Build is slow (isaac typing more)", base: "Build is slow (isaac typing" }, "isaac");
  expect(mine.text).toBe("AGENT. Build is slow (isaac typing more)\n\nagent: measured 6 min");
});

test("the merge keeps several separate changes from each side", () => {
  expect(mergeText("a b c d e", "a B c d e!", "a b c D e")).toBe("a B c D e!");
  expect(mergeText("start", "start mine", "start\n\ntheirs")).toBe("start mine\n\ntheirs");
  expect(mergeText("x", "y", "z")).toBeUndefined();
});
