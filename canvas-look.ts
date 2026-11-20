import type { CanvasNode } from "./canvas";

export type Seen = { text: string; x: number; y: number };
export type Snapshot = Record<string, Seen>;

const MAX_TEXT = 600;
const MOVE_WORTH_TELLING_PX = 150;

const quoted = (text: string) => JSON.stringify(text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);
const at = (n: Seen) => `(${Math.round(n.x)},${Math.round(n.y)})`;

export const snapshotOf = (nodes: CanvasNode[]): Snapshot => Object.fromEntries(nodes.map((n) => [n.id, { text: n.text, x: n.x, y: n.y }]));

function changeLine(was: Seen | undefined, n: CanvasNode) {
  if (!was) return `+ added ${n.id} at ${at(n)}: ${quoted(n.text)}`;
  if (was.text !== n.text) return `~ edited ${n.id}\n    was: ${quoted(was.text)}\n    now: ${quoted(n.text)}`;
  const isFar = Math.hypot(was.x - n.x, was.y - n.y) > MOVE_WORTH_TELLING_PX;
  return isFar ? `> moved ${n.id} to ${at(n)}` : undefined;
}

export function diffOf(before: Snapshot, nodes: CanvasNode[]): string[] {
  const now = new Set(nodes.map((n) => n.id));
  const changed = nodes.flatMap((n) => changeLine(before[n.id], n) ?? []);
  const removed = Object.entries(before)
    .filter(([id]) => !now.has(id))
    .map(([id, was]) => `- deleted ${id}: ${quoted(was.text)}`);
  return [...changed, ...removed];
}
