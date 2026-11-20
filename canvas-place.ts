export type Rect = { x: number; y: number; width: number; height: number };
type Spot = { x: number; y: number };

const GAP = 40;
const RINGS = 12;

const isClear = (spot: Rect, others: Rect[]) =>
  others.every((b) => spot.x >= b.x + b.width + GAP || b.x >= spot.x + spot.width + GAP || spot.y >= b.y + b.height + GAP || b.y >= spot.y + spot.height + GAP);

function candidates(target: Rect, size: { width: number; height: number }, ring: number): Spot[] {
  const down = ring * (size.height + GAP);
  const across = ring * (size.width + GAP);
  const right = target.x + target.width + GAP;
  const below = target.y + target.height + GAP;
  return [
    { x: right, y: target.y + down },
    { x: target.x + across, y: below },
    { x: right, y: target.y - down },
    { x: target.x - size.width - GAP, y: target.y + down },
    { x: target.x + across, y: target.y - size.height - GAP },
  ];
}

export function freeSpotNear(target: Rect, size: { width: number; height: number }, others: Rect[]): Spot {
  for (let ring = 0; ring <= RINGS; ring++) {
    const spot = candidates(target, size, ring).find((c) => isClear({ x: c.x, y: c.y, width: size.width, height: size.height }, others));
    if (spot) return spot;
  }
  const rightmost = Math.max(...others.map((b) => b.x + b.width), target.x + target.width);
  return { x: rightmost + GAP, y: target.y };
}

export const isFree = (spot: Rect, others: Rect[]) => isClear(spot, others);

const CHARS_PER_PX = 1 / 7.4;
const LINE_PX = 22;
const PADDING_PX = 40;
const MAX_FIT_PX = 420;

export function heightFor(text: string, width: number) {
  const perLine = Math.max(10, Math.floor((width - 24) * CHARS_PER_PX));
  const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return Math.min(MAX_FIT_PX, PADDING_PX + lines * LINE_PX);
}
