import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeText } from "../shared/merge-text";

process.env["YARN_DOCS"] ??= mkdtempSync(join(tmpdir(), "yarn-canvas-"));
const canvas = await import("../canvas");
const { DOCS_DIR } = await import("../docs");
const look = await import("../canvas-look");
type Rect = { x: number; y: number; width: number; height: number };

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
  canvas.linkNode(path, a.id, { text: "deploy", to: b.id }, "isaac");
  expect(canvas.readCanvas(path).canvas.nodes[0]?.text).toBe(`Why is the [deploy](#${b.id}) slow?`);
  expect(() => canvas.linkNode(path, a.id, { text: "deploy", to: b.id }, "isaac")).toThrow();

  const edited = canvas.editNode(path, a.id, { text: "Why is the deploy so slow?", base: "Why is the deploy slow?" }, "isaac");
  expect(edited.text).toBe(`Why is the [deploy](#${b.id}) so slow?`);
  expect(canvas.editNode(path, b.id, { x: 500 }, "agent1")).toMatchObject({ x: 500, y: 20, author: "agent1" });

  canvas.removeNode(path, b.id, "agent1");
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

test("an agent can't replace its box while Isaac is typing in it, but append merges with his typing", () => {
  const { path } = canvas.createCanvas(`${HERE}/typing`);
  const box = canvas.addNode(path, { text: "Build is slow" }, "agent1");
  canvas.markTyping(path, box.id);
  expect(() => canvas.editNode(path, box.id, { text: "AGENT. Build is slow" }, "agent1")).toThrow(/typing/);
  canvas.editNode(path, box.id, { append: "agent: measured 6 min" }, "agent1");
  const mine = canvas.editNode(path, box.id, { text: "Build is slow (isaac)", base: "Build is slow" }, "isaac");
  expect(mine).toMatchObject({ text: "Build is slow (isaac)\n\nagent: measured 6 min", author: "isaac" });
  expect(() => canvas.editNode(path, box.id, { append: "more" }, "agent1")).toThrow(/propose/);
});

test("on Isaac's box an agent only proposes; accepting merges with what he typed since, rejecting leaves it", () => {
  const { path } = canvas.createCanvas(`${HERE}/propose`);
  const his = canvas.addNode(path, { text: "Ship Friday. Tell the team." }, "isaac");
  expect(() => canvas.removeNode(path, his.id, "agent1")).toThrow(/isaac's/);
  expect(() => canvas.linkNode(path, his.id, { text: "team", to: his.id }, "agent1")).toThrow(/isaac's/);
  canvas.proposeText(path, his.id, "Ship Thursday. Tell the team.", "agent1");
  canvas.editNode(path, his.id, { text: "Ship Friday. Tell the whole team.", base: "Ship Friday. Tell the team." }, "isaac");
  expect(() => canvas.settleProposal(path, his.id, true, "agent1")).toThrow(/only isaac/);
  const accepted = canvas.settleProposal(path, his.id, true, "isaac");
  expect(accepted.text).toBe("Ship Thursday. Tell the whole team.");
  expect(accepted.proposal).toBeUndefined();
  canvas.proposeText(path, his.id, "Ship now.", "agent1");
  expect(canvas.settleProposal(path, his.id, false, "isaac").text).toBe("Ship Thursday. Tell the whole team.");
});

test("a box added near another lands in free space beside it, joined by an edge", () => {
  const { path } = canvas.createCanvas(`${HERE}/near`);
  const target = canvas.addNode(path, { text: "target", x: 0, y: 0 }, "isaac");
  canvas.addNode(path, { text: "in the way", x: 300, y: 0 }, "isaac");
  const added = canvas.addNode(path, { text: "about target", near: target.id }, "agent1");
  const { nodes, edges } = canvas.readCanvas(path).canvas;
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(nodes.filter((n) => n.id !== added.id).some((n) => overlaps(n, added))).toBe(false);
  expect(edges).toContainEqual(expect.objectContaining({ fromNode: target.id, toNode: added.id }));
  expect(Math.hypot(added.x - target.x, added.y - target.y)).toBeLessThan(500);
});

test("the look diff names what Isaac added, edited, moved far and deleted", () => {
  const before = look.snapshotOf([
    { id: "a", type: "text", text: "old", x: 0, y: 0, width: 10, height: 10 },
    { id: "b", type: "text", text: "gone", x: 0, y: 0, width: 10, height: 10 },
    { id: "c", type: "text", text: "same", x: 0, y: 0, width: 10, height: 10 },
  ]);
  const lines = look.diffOf(before, [
    { id: "a", type: "text", text: "new", x: 0, y: 0, width: 10, height: 10 },
    { id: "c", type: "text", text: "same", x: 5, y: 5, width: 10, height: 10 },
    { id: "d", type: "text", text: "fresh", x: 0, y: 0, width: 10, height: 10 },
  ]);
  expect(lines).toEqual(['~ edited a\n    was: "old"\n    now: "new"', '+ added d at (0,0): "fresh"', '- deleted b: "gone"']);
});

test("the merge keeps several separate changes from each side", () => {
  expect(mergeText("a b c d e", "a B c d e!", "a b c D e")).toBe("a B c D e!");
  expect(mergeText("start", "start mine", "start\n\ntheirs")).toBe("start mine\n\ntheirs");
  expect(mergeText("x", "y", "z")).toBeUndefined();
});
