export type Point = { x: number; y: number };
export type Box = { left: number; top: number; right: number; bottom: number };

const CLIPPING = /auto|scroll|hidden|clip/;
const TIP_X_MAX = 28;
const TIP_Y_MAX = 18;

const clippersOf = new WeakMap<Element, Element[]>();

export const elementsFor = (id: string) => document.querySelectorAll(`[data-agent="${CSS.escape(id)}"]`);

function clippers(el: Element) {
  const known = clippersOf.get(el);
  if (known) return known;
  const found: Element[] = [];
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const style = getComputedStyle(a);
    if (CLIPPING.test(style.overflowX) || CLIPPING.test(style.overflowY)) found.push(a);
  }
  clippersOf.set(el, found);
  return found;
}

const intersect = (a: Box, b: Box): Box => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

export function clipBox(el: Element): Box {
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  return clippers(el).reduce<Box>((box, a) => intersect(box, a.getBoundingClientRect()), viewport);
}

export const tipOf = (r: DOMRect): Point => ({ x: r.left + Math.min(r.width / 2, TIP_X_MAX), y: r.top + Math.min(r.height / 2, TIP_Y_MAX) });

export const isInside = (p: Point, b: Box) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;

export function clampInto(p: Point, b: Box, inset: number): Point {
  const left = Math.min(b.left + inset, b.right - inset);
  const top = Math.min(b.top + inset, b.bottom - inset);
  return { x: Math.min(Math.max(p.x, left), Math.max(left, b.right - inset)), y: Math.min(Math.max(p.y, top), Math.max(top, b.bottom - inset)) };
}

export const isShown = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
};

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

export function along(from: Point, to: Point, bend: number, t: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const control = { x: (from.x + to.x) / 2 - dy * bend, y: (from.y + to.y) / 2 + dx * bend };
  const u = 1 - t;
  return { x: u * u * from.x + 2 * u * t * control.x + t * t * to.x, y: u * u * from.y + 2 * u * t * control.y + t * t * to.y };
}

export const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

export const flightMs = (miles: number, speed: number) => (320 + 140 * Math.log2(1 + miles / 48)) / speed;

export const degreesToward = (from: Point, to: Point) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
