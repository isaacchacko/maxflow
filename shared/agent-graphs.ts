import { isRecord, stringOr } from "./guards";

export const MODELS = ["opus", "sonnet", "haiku", "fable"] as const;
export type Model = (typeof MODELS)[number];

export type AgentNode = { id: string; name: string; role: string; prompt: string; model: Model; col: number; row: number };
export type Edge = { id: string; from: string; to: string; label: string };
export type AgentGraph = { id: string; name: string; goal: string; nodes: AgentNode[]; edges: Edge[]; updatedAt: string };
export type GraphSummary = Pick<AgentGraph, "id" | "name" | "goal" | "updatedAt"> & { agents: number };

export const MAX_COLS = 24;
export const MAX_ROWS = 24;

export const cellKey = (col: number, row: number) => `${col},${row}`;
const isCell = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < max;
const isModel = (m: unknown): m is Model => MODELS.includes(m as Model);

function nodeOf(raw: unknown): AgentNode | string {
  if (!isRecord(raw)) return "a node is not an object";
  const { id, col, row, model } = raw;
  if (typeof id !== "string" || id === "") return "a node has no id";
  if (!isCell(col, MAX_COLS) || !isCell(row, MAX_ROWS)) return `node ${id} is off the grid`;
  return { id, name: stringOr(raw["name"]), role: stringOr(raw["role"]), prompt: stringOr(raw["prompt"]), model: isModel(model) ? model : "opus", col, row };
}

function edgeOf(raw: unknown, ids: Set<string>): Edge | string {
  if (!isRecord(raw)) return "an edge is not an object";
  const { id, from, to } = raw;
  if (typeof id !== "string" || id === "") return "an edge has no id";
  if (typeof from !== "string" || typeof to !== "string" || !ids.has(from) || !ids.has(to)) return `edge ${id} points at a missing node`;
  if (from === to) return `edge ${id} loops onto its own node`;
  return { id, from, to, label: stringOr(raw["label"]) };
}

function nodesOf(raw: unknown): AgentNode[] | string {
  if (!Array.isArray(raw)) return "nodes is not a list";
  const nodes: AgentNode[] = [];
  const cells = new Set<string>();
  for (const r of raw) {
    const node = nodeOf(r);
    if (typeof node === "string") return node;
    if (nodes.some(n => n.id === node.id)) return `two nodes share id ${node.id}`;
    const cell = cellKey(node.col, node.row);
    if (cells.has(cell)) return `two nodes sit in cell ${cell}`;
    cells.add(cell);
    nodes.push(node);
  }
  return nodes;
}

function edgesOf(raw: unknown, nodes: AgentNode[]): Edge[] | string {
  if (!Array.isArray(raw)) return "edges is not a list";
  const ids = new Set(nodes.map(n => n.id));
  const edges: Edge[] = [];
  for (const r of raw) {
    const edge = edgeOf(r, ids);
    if (typeof edge === "string") return edge;
    if (edges.some(e => e.from === edge.from && e.to === edge.to)) return `two edges run ${edge.from} → ${edge.to}`;
    edges.push(edge);
  }
  return edges;
}

/** Checks a graph sent by a client: every node on its own grid cell, every edge between two real, different nodes. */
export function graphOf(raw: unknown, id: string): Omit<AgentGraph, "updatedAt"> | string {
  if (!isRecord(raw)) return "the graph is not an object";
  const nodes = nodesOf(raw["nodes"]);
  if (typeof nodes === "string") return nodes;
  const edges = edgesOf(raw["edges"], nodes);
  if (typeof edges === "string") return edges;
  return { id, name: stringOr(raw["name"], "Untitled graph"), goal: stringOr(raw["goal"]), nodes, edges };
}
