import { type AgentGraph, type AgentNode, cellKey, MAX_COLS, MAX_ROWS } from "../../../shared/agent-graphs";

/** The grid every node snaps to: a node fills one cell, and the gutters between cells carry the edges, so no edge ever crosses a node. */
export const CELL_W = 248;
export const CELL_H = 128;
export const NODE_W = 172;
export const NODE_H = 80;
export const PAD = 32;
const INSET_X = (CELL_W - NODE_W) / 2;
const INSET_Y = (CELL_H - NODE_H) / 2;
const SPARE = 2;

export type Point = { x: number; y: number };
export type Cell = { col: number; row: number };

export const nodeX = (col: number) => PAD + col * CELL_W + INSET_X;
export const nodeY = (row: number) => PAD + row * CELL_H + INSET_Y;
const columnGutter = (col: number) => PAD + col * CELL_W;
const rowGutter = (row: number) => PAD + row * CELL_H;
const outPort = (n: Cell): Point => ({ x: nodeX(n.col) + NODE_W, y: nodeY(n.row) + NODE_H / 2 });
const inPort = (n: Cell): Point => ({ x: nodeX(n.col), y: nodeY(n.row) + NODE_H / 2 });

export function cellAt(p: Point): Cell {
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max - 1, n));
  return { col: clamp(Math.floor((p.x - PAD) / CELL_W), MAX_COLS), row: clamp(Math.floor((p.y - PAD) / CELL_H), MAX_ROWS) };
}

export const isOnNode = (p: Point, c: Cell) => p.x >= nodeX(c.col) && p.x <= nodeX(c.col) + NODE_W && p.y >= nodeY(c.row) && p.y <= nodeY(c.row) + NODE_H;

export function gridSize(nodes: AgentNode[]) {
  const cols = Math.min(MAX_COLS, Math.max(5, ...nodes.map(n => n.col + 1 + SPARE)));
  const rows = Math.min(MAX_ROWS, Math.max(4, ...nodes.map(n => n.row + 1 + SPARE)));
  return { cols, rows, width: PAD * 2 + cols * CELL_W, height: PAD * 2 + rows * CELL_H };
}

const LANE_GAP = 10;
const GUTTER_ROOM = 36;

type Lanes = Map<string, string[]>;
const exitGutter = (e: { from: Cell }) => `c${e.from.col + 1}`;
const entryGutter = (e: { to: Cell }) => `c${e.to.col}`;
const rowLane = (e: { from: Cell; to: Cell }) => `r${e.to.row < e.from.row ? e.from.row : e.from.row + 1}`;

function laneOffset(lanes: Lanes, gutter: string, id: string) {
  const users = lanes.get(gutter) ?? [id];
  const gap = users.length < 2 ? 0 : Math.min(LANE_GAP, GUTTER_ROOM / (users.length - 1));
  return (users.indexOf(id) - (users.length - 1) / 2) * gap;
}

function routeOf(from: Cell, to: Cell, offset: (gutter: string) => number): Point[] {
  const a = outPort(from);
  const b = inPort(to);
  const e = { from, to };
  const exitX = columnGutter(from.col + 1) + offset(exitGutter(e));
  if (exitGutter(e) === entryGutter(e)) return [a, { x: exitX, y: a.y }, { x: exitX, y: b.y }, b];
  const entryX = columnGutter(to.col) + offset(entryGutter(e));
  const lane = rowLane(e);
  const laneY = rowGutter(Number(lane.slice(1))) + offset(lane);
  return [a, { x: exitX, y: a.y }, { x: exitX, y: laneY }, { x: entryX, y: laneY }, { x: entryX, y: b.y }, b];
}

/**
 * Right angles only, and only through gutters: out of the source's right side into the column gutter after it,
 * along a row gutter when the target is not in the next column, down the column gutter before the target, into its left side.
 * Edges sharing a gutter each get a lane of their own in it, so no two run on top of each other.
 */
export function routes(g: AgentGraph): Map<string, Point[]> {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const lanes: Lanes = new Map();
  const use = (gutter: string, id: string) => lanes.set(gutter, [...(lanes.get(gutter) ?? []), id]);
  const placed = g.edges.flatMap(edge => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from && to ? [{ id: edge.id, from, to }] : [];
  });
  for (const e of placed.toSorted((x, y) => x.from.row + x.to.row - (y.from.row + y.to.row))) {
    use(exitGutter(e), e.id);
    if (entryGutter(e) !== exitGutter(e)) {
      use(entryGutter(e), e.id);
      use(rowLane(e), e.id);
    }
  }
  return new Map(placed.map(e => [e.id, routeOf(e.from, e.to, gutter => laneOffset(lanes, gutter, e.id))]));
}

export function routeToPoint(from: Cell, p: Point): Point[] {
  const a = outPort(from);
  const exitX = Math.max(a.x + INSET_X, p.x - INSET_X);
  return [a, { x: exitX, y: a.y }, { x: exitX, y: p.y }, p];
}

export const pathOf = (points: Point[]) => points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");

const lengthOf = (p: Point, q: Point) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
const LABEL_ROOM = 64;

/** Where an edge's label sits: on its longest horizontal run when one has room, else on its longest run. */
export function labelAt(points: Point[]): Point {
  const runs = points.slice(1).map((p, i) => ({ p, q: points[i] ?? p })).map(({ p, q }) => ({ length: lengthOf(p, q), isFlat: p.y === q.y, at: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } }));
  const longest = (rs: typeof runs) => rs.toSorted((a, b) => b.length - a.length)[0];
  return (longest(runs.filter(r => r.isFlat && r.length >= LABEL_ROOM)) ?? longest(runs))?.at ?? points[0] ?? { x: 0, y: 0 };
}

export const nodeIn = (g: AgentGraph, c: Cell) => g.nodes.find(n => n.col === c.col && n.row === c.row);

/** Puts a node in a cell; whoever sat there takes the node's old cell, so two nodes never share one. */
export function moveTo(g: AgentGraph, id: string, c: Cell): AgentGraph {
  const moving = g.nodes.find(n => n.id === id);
  if (!moving || (moving.col === c.col && moving.row === c.row)) return g;
  const there = nodeIn(g, c);
  const nodes = g.nodes.map(n => {
    if (n.id === id) return { ...n, ...c };
    return n.id === there?.id ? { ...n, col: moving.col, row: moving.row } : n;
  });
  return { ...g, nodes };
}

export function firstFreeCell(g: AgentGraph): Cell {
  const taken = new Set(g.nodes.map(n => cellKey(n.col, n.row)));
  const rows = gridSize(g.nodes).rows;
  for (let col = 0; col < MAX_COLS; col++) for (let row = 0; row < rows; row++) if (!taken.has(cellKey(col, row))) return { col, row };
  return { col: 0, row: 0 };
}
