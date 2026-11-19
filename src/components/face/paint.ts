import type { Frame } from "./rig";

const r1 = (n: number) => Math.round(n * 100) / 100;

type EyeOutline = { cx: number; cy: number; w: number; h: number; angle: number; smile: number; k: number };

const EYE_STEPS = 10;

function pillBendingIntoCaret({ w, h, smile, k }: EyeOutline) {
  const r = Math.min(w, h) / 2;
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let i = 0; i <= EYE_STEPS; i++) {
    const x = (-w / 2) * Math.cos((Math.PI * i) / EYE_STEPS);
    const u = (2 * x) / w;
    const a = Math.max(0, Math.abs(x) - (w / 2 - r));
    const hh = h / 2 - r + Math.sqrt(Math.max(0, r * r - a * a));
    const arc = (0.9 - 1.6 * (1 - u * u)) * k;
    const t = 2.1 * k * (0.5 + 0.5 * Math.sqrt(Math.max(0, 1 - u * u)));
    top.push([x, -hh + (arc - t / 2 + hh) * smile]);
    bottom.push([x, hh + (arc + t / 2 - hh) * smile]);
  }
  return [...top, ...bottom.toReversed()];
}

function eyePath(eye: EyeOutline) {
  const c = Math.cos(eye.angle);
  const sn = Math.sin(eye.angle);
  const pts = pillBendingIntoCaret(eye).map(([x, y]) => `${r1(eye.cx + x * c - y * sn)} ${r1(eye.cy + x * sn + y * c)}`);
  return `M${pts.join("L")}Z`;
}

export type Geometry = { lx: number; ly: number; rx: number; ry: number; k: number; brows: boolean; small: boolean; face: string; back: string; line: string; round: boolean };

const SLAB_DEPTH = 5;
export const SLABS = 10;
const squash = (c: number, off: number) => `translate(${r1(16 + off)} 0) scale(${r1(Math.max(Math.abs(c), 0.015) * 1000) / 1000} 1) translate(-16 0)`;

function eyeIn(f: Frame, k: number) {
  type EyeAt = { x: number; y: number; open: number; angle: number; far: number };
  const dx = f.gx * 1.5 * k;
  const dy = f.gy * 1.3 * k;
  return ({ x, y, open, angle, far }: EyeAt) => {
    const w = 3.2 * k * f.width * (1 - 0.14 * far);
    const h = Math.max(0.7 * k, 6 * k * open * Math.max(f.blink, f.smile > 0.5 ? 0.45 : 0));
    return eyePath({ cx: x + dx, cy: y + dy, w, h, angle, smile: f.smile, k });
  };
}

function browIn(f: Frame, k: number) {
  const dx = f.gx * 1.5 * k;
  const dy = f.gy * 1.3 * k;
  return (x: number, y: number, side: -1 | 1) => {
    const open = Math.max(f.leftOpen, f.rightOpen);
    const by = y + dy - 3 * k * Math.max(open, 0.6) - 1.4 * k - f.browLift * 1.5 * k + side * f.browAsym * 0.5 * k;
    const t = -f.browAngle * 2 * k * side;
    return `M${r1(x + dx - 2.1 * k)} ${r1(by - t)}L${r1(x + dx + 2.1 * k)} ${r1(by + t)}`;
  };
}

function risingZs(f: Frame, g: Geometry) {
  const zCount = g.small ? 2 : 3;
  return Array.from({ length: zCount }, (_, i) => {
    const t = (f.z + i / zCount) % 1;
    return {
      x: r1(g.rx + 3 + 3.5 * t + Math.sin(Math.PI * t)),
      y: r1(g.ry - 4 - 9 * t),
      o: f.z === 0 ? 0 : r1(0.85 * Math.sin(Math.PI * t) ** 1.5),
      s: r1((i % 2 === 1 ? 5 : 4) + 1.5 * t),
    };
  });
}

function turningSlab(f: Frame, g: Geometry) {
  const c = Math.cos(f.turn);
  const side = Math.sin(f.turn) * SLAB_DEPTH;
  return {
    cap: squash(c, (c >= 0 ? -side : side) / 2),
    capFill: c >= 0 ? g.face : g.back,
    eyes: r1(Math.max(0, Math.min(1, (c - 0.2) * 4))),
    slabs: Array.from({ length: SLABS }, (_, i) => squash(c, side * (i / (SLABS - 1) - 0.5))),
  };
}

export function paint(f: Frame, g: Geometry) {
  const eye = eyeIn(f, g.k);
  const brow = browIn(f, g.k);
  const deg = (f.rot * 180) / Math.PI;
  return {
    ...turningSlab(f, g),
    head: `translate(${r1(f.x)} ${r1(f.y)}) rotate(${r1(deg)} 16 18) translate(16 27) scale(${r1(f.scale * 1000) / 1000}) translate(-16 -27)`,
    left: eye({ x: g.lx, y: g.ly, open: f.leftOpen, angle: f.leftAngle, far: Math.max(0, f.gx) }),
    right: eye({ x: g.rx, y: g.ry, open: f.rightOpen, angle: f.rightAngle, far: Math.max(0, -f.gx) }),
    browL: g.brows ? brow(g.lx, g.ly, -1) : "",
    browR: g.brows ? brow(g.rx, g.ry, 1) : "",
    browOpacity: r1(f.brow * 0.6),
    zs: risingZs(f, g),
  };
}

export type Painted = ReturnType<typeof paint>;

export const SLEEPING_Z = "M-1.3 -1.6H1.3L-1.3 1.6H1.3";
export const zAt = (x: number, y: number, size: number) => `translate(${x} ${r1(y - size / 2)}) scale(${r1(size / 5.5)})`;
