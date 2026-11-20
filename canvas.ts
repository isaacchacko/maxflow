import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOCS_DIR, saveFile, vaultPath } from "./docs";
import { mergeText } from "./shared/merge-text";

// constraint: the file is JSON Canvas (jsoncanvas.org), which Obsidian opens too; author, who made or last edited a box, is our only addition
export type CanvasNode = { id: string; type: "text"; text: string; x: number; y: number; width: number; height: number; color?: string; author?: string };
export type Canvas = { nodes: CanvasNode[]; edges: { id: string; fromNode: string; toNode: string }[] };
export type Box = Partial<Pick<CanvasNode, "text" | "x" | "y" | "width" | "height" | "color">>;

type Held = { canvas: Canvas; mtimeMs: number; rev: number };

const DEFAULT_SIZE = { width: 260, height: 120 };
const held = new Map<string, Held>();
const changeListeners = new Set<(path: string, rev: number) => void>();

export class CanvasConflict extends Error {
  constructor(readonly node: CanvasNode) {
    super(`box ${node.id} changed under you in the same place`);
  }
}

export const canvasPath = (path: string) => vaultPath(path.endsWith(".canvas") ? path : `${path}.canvas`);
export const onCanvasChange = (listener: (path: string, rev: number) => void) => changeListeners.add(listener);
const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const linkTo = (id: string) => new RegExp(String.raw`\[([^\]]*)\]\(#${id}\)`, "g");

function parsed(text: string): Canvas {
  const raw = JSON.parse(text === "" ? "{}" : text) as { nodes?: (Omit<CanvasNode, "type"> & { type: string })[]; edges?: Canvas["edges"] };
  return { nodes: (raw.nodes ?? []).filter((n): n is CanvasNode => n.type === "text"), edges: raw.edges ?? [] };
}

function heldAt(path: string): Held {
  const file = join(DOCS_DIR, path);
  if (!existsSync(file)) {
    held.delete(path);
    throw new Error(`no canvas ${path}`);
  }
  const { mtimeMs } = statSync(file);
  const was = held.get(path);
  if (was?.mtimeMs === mtimeMs) return was;
  const now = { canvas: parsed(readFileSync(file, "utf8")), mtimeMs, rev: (was?.rev ?? 0) + 1 };
  held.set(path, now);
  return now;
}

function save(path: string, was: Held) {
  saveFile(path, `${JSON.stringify(was.canvas, null, "\t")}\n`);
  const now = { ...was, mtimeMs: statSync(join(DOCS_DIR, path)).mtimeMs, rev: was.rev + 1 };
  held.set(path, now);
  for (const listener of changeListeners) listener(path, now.rev);
}

function nodeIn(h: Held, id: string) {
  const node = h.canvas.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no box ${id}`);
  return node;
}

export function readCanvas(path: string) {
  const h = heldAt(canvasPath(path));
  return { path: canvasPath(path), rev: h.rev, canvas: h.canvas };
}

export function createCanvas(path: string) {
  const inVault = canvasPath(path);
  if (existsSync(join(DOCS_DIR, inVault))) throw new Error(`${inVault} already exists`);
  saveFile(inVault, `${JSON.stringify({ nodes: [], edges: [] }, null, "\t")}\n`);
  return readCanvas(inVault);
}

const finite = (n: unknown, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback);

function placed(box: Box, base: Pick<CanvasNode, "x" | "y" | "width" | "height">) {
  return { x: finite(box.x, base.x), y: finite(box.y, base.y), width: Math.max(40, finite(box.width, base.width)), height: Math.max(30, finite(box.height, base.height)) };
}

export function addNode(path: string, box: Box, author: string) {
  const inVault = canvasPath(path);
  const h = heldAt(inVault);
  const node: CanvasNode = { id: newId(), type: "text", text: box.text ?? "", ...placed(box, { x: 0, y: 0, ...DEFAULT_SIZE }), ...(box.color !== undefined && { color: box.color }), author };
  h.canvas.nodes.push(node);
  save(inVault, h);
  return node;
}

export type Edit = Box & { base?: string; find?: string; replace?: string; append?: string };

const ISAAC = "isaac";
const TYPING_MS = 5000;
const typingUntil = new Map<string, number>();
const typingKey = (path: string, id: string) => `${canvasPath(path)}\n${id}`;

export const markTyping = (path: string, id: string) => typingUntil.set(typingKey(path, id), Date.now() + TYPING_MS);
const isTyping = (path: string, id: string) => (typingUntil.get(typingKey(path, id)) ?? 0) > Date.now();

function wholeText(path: string, node: CanvasNode, edit: Edit & { text: string }, author: string) {
  if (edit.base !== undefined && edit.base !== node.text) return mergeText(edit.base, edit.text, node.text);
  if (edit.base === undefined && author !== ISAAC && isTyping(path, node.id)) throw new Error(`isaac is typing in box ${node.id}: use replace or append, which merge with his typing`);
  return edit.text;
}

function newText(path: string, node: CanvasNode, edit: Edit, author: string) {
  if (typeof edit.find === "string") {
    if (edit.find === "" || !node.text.includes(edit.find)) throw new Error(`"${edit.find}" isn't in box ${node.id}`);
    return node.text.replace(edit.find, () => edit.replace ?? "");
  }
  if (typeof edit.append === "string") return node.text.trim() === "" ? edit.append : `${node.text.trimEnd()}\n\n${edit.append}`;
  return typeof edit.text === "string" ? wholeText(path, node, { ...edit, text: edit.text }, author) : node.text;
}

export function editNode(path: string, id: string, edit: Edit, author: string) {
  const inVault = canvasPath(path);
  const h = heldAt(inVault);
  const node = nodeIn(h, id);
  const text = newText(inVault, node, edit, author);
  if (text === undefined) throw new CanvasConflict(node);
  if (text !== node.text) Object.assign(node, { text, author });
  Object.assign(node, placed(edit, node), edit.color === undefined ? {} : { color: edit.color });
  save(inVault, h);
  return node;
}

export function removeNode(path: string, id: string) {
  const inVault = canvasPath(path);
  const h = heldAt(inVault);
  nodeIn(h, id);
  h.canvas.nodes = h.canvas.nodes.filter((n) => n.id !== id);
  h.canvas.edges = h.canvas.edges.filter((e) => e.fromNode !== id && e.toNode !== id);
  for (const n of h.canvas.nodes) n.text = n.text.replace(linkTo(id), "$1");
  save(inVault, h);
  return { id };
}

function unlinkedAt(text: string, phrase: string, near: number) {
  const links = text
    .matchAll(/\[[^\]]*\]\([^)]*\)/g)
    .map((m) => [m.index, m.index + m[0].length] as const)
    .toArray();
  const found: number[] = [];
  for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
    if (links.every(([start, end]) => at >= end || at + phrase.length <= start)) found.push(at);
  }
  return found.toSorted((a, b) => Math.abs(a - near) - Math.abs(b - near))[0] ?? -1;
}

export function linkNode(path: string, from: string, { text: phrase, to, near = 0 }: { text: string; to: string; near?: number }, author: string) {
  const inVault = canvasPath(path);
  const h = heldAt(inVault);
  const node = nodeIn(h, from);
  nodeIn(h, to);
  if (phrase.trim() === "" || /[[\]]/.test(phrase)) throw new Error("link text must be plain text without brackets");
  const at = unlinkedAt(node.text, phrase, near);
  if (at === -1) throw new Error(`"${phrase}" isn't unlinked text in box ${from}`);
  Object.assign(node, { text: `${node.text.slice(0, at)}[${phrase}](#${to})${node.text.slice(at + phrase.length)}`, author });
  save(inVault, h);
  return node;
}
