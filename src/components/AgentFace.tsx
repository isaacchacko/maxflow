import { cn } from "@/lib/utils";
import { useCallback, useId, useRef } from "react";
import { createLife, restFrame, step, type Expression, type Frame, type Life } from "./face/rig";

// An agent's face: a soft paper body with a deeper edge behind it, and all the expression in the eyes and brows, no mouth.
// Shape, hue and eye spacing come from the id, so each agent (or pinned thread) keeps one face. Its expression follows what it is
// doing, and a living face moves: face/rig.ts springs its eyes from one expression into the next and gives it blinks, a
// wandering gaze and each state's own motion. Lists of many faces draw them `still`, in their expression's resting pose.

export type { Expression };

// A body: its outline, where the eyes sit (y, and the widest half-spread that still fits), how much to shrink them, and how
// round to make its corners (polygons are drawn sharp and rounded with a stroke of the same colour).
type Shape = { name: string; d: string; cy: number; spread: number; scale?: number; round?: number; brows?: false; smallZoom?: number; eyes?: [[number, number], [number, number]] };
const SHAPES: Shape[] = [
  { name: "round", d: "M16 4.4c6.8 0 11.6 4.2 11.6 11 0 7.2-4.8 12.2-11.6 12.2S4.4 22.6 4.4 15.4C4.4 8.6 9.2 4.4 16 4.4z", cy: 15.6, spread: 4.6 },
  { name: "squircle", d: "M16 5c6.9 0 10.8.6 11 6.8.2 3.4.2 6.4 0 9.6-.4 5.6-4.4 6.2-11 6.2s-10.6-.6-11-6.2c-.2-3.2-.2-6.2 0-9.6C5.2 5.6 9.1 5 16 5z", cy: 15.6, spread: 4.6 },
  { name: "pebble", d: "M15.4 7.2c7.4-.4 12.8 3 12.8 9.2 0 6.4-5.4 10-12.4 10C8.6 26.4 3.8 23 3.8 17c0-5.8 4.6-9.4 11.6-9.8z", cy: 16.4, spread: 4.6 },
  { name: "bean", d: "M16.6 4c5.6.2 9.4 4.4 9.6 10.6.2 7.6-4 13-10.4 13-6.2 0-9.8-4.6-9.8-11.2C6 9 10.4 3.8 16.6 4z", cy: 15.4, spread: 4.2 },
  { name: "bun", d: "M16 6c7 0 12 4.4 12 10.8v5.6c0 3.2-2 4.6-5 4.6H9c-3 0-5-1.4-5-4.6v-5.6C4 10.4 9 6 16 6z", cy: 17, spread: 4.6 },
  { name: "drop", d: "M17.4 4.2c5.4 1.6 9.6 6.2 9.6 12.2 0 6.4-4.8 11.2-11 11.2S5 22.8 5 16.6C5 9 10.6 2.2 17.4 4.2z", cy: 16.4, spread: 4.2 },
  { name: "cloud", d: "M9 26.4h14.6c3.4 0 5.6-2.3 5.6-5.3 0-2.9-2-5-4.7-5.3.1-4.4-3.4-7.9-7.9-7.9-3 0-5.4 1.6-6.6 4C6.6 12 4 14.8 4 18.6c0 4.2 2.6 7.8 5 7.8z", cy: 19.2, spread: 3.9 },
  { name: "star", d: "M16 6L19.17 13.03L26.84 13.88L21.14 19.07L22.7 26.62L16 22.8L9.3 26.62L10.86 19.07L5.16 13.88L12.83 13.03Z", cy: 17.4, spread: 2.5, scale: 0.75, round: 3.2 },
  { name: "heart", d: "M16 27.4C9.2 22.8 4.2 18.6 4.2 12.8 4.2 9 7 6.2 10.5 6.2c2.4 0 4.3 1.2 5.5 3.2 1.2-2 3.1-3.2 5.5-3.2 3.5 0 6.3 2.8 6.3 6.6 0 5.8-5 10-11.8 14.6z", cy: 14.8, spread: 4.4, scale: 0.9 },
  { name: "diamond", d: "M16 4.6L27.4 16L16 27.4L4.6 16Z", cy: 16, spread: 3.2, scale: 0.85, round: 4 },
  { name: "shield", d: "M5.6 7.6c3.8-.6 7.1-1.9 10.4-3.8 3.3 1.9 6.6 3.2 10.4 3.8v7.6c0 6.8-4.4 11.2-10.4 13.6C10 26.4 5.6 22 5.6 15.2z", cy: 14.6, spread: 3.8 },
  { name: "slender", d: "M16 3.6c5 0 7.6 3.6 7.6 9.4v6.4c0 5.6-3 9.2-7.6 9.2s-7.6-3.6-7.6-9.2V13C8.4 7.2 11 3.6 16 3.6z", cy: 14.6, spread: 3, scale: 0.9 },
  { name: "pocket", d: "M5 9c0-1.8 1.2-2.9 3-2.7 5.4.7 10.6.7 16 0 1.8-.2 3 .9 3 2.7v11.6c0 3.6-2.4 5.6-6 5.6H11c-3.6 0-6-2-6-5.6z", cy: 16.6, spread: 4.6 },
  // Isaac's company, Dryft: its logo's silhouette, eyes riding up the diagonal band.
  { name: "dryft", d: "M20.13 7.2C20.75 6.64 21.74 7.07 21.74 7.91V12.97C21.81 14.34 22.91 15.44 24.29 15.49H27.08C27.69 15.49 28.0 16.24 27.57 16.67L22.31 21.93C21.87 22.36 21.13 22.06 21.13 21.44V17.58C21.12 16.64 20.89 15.87 19.89 15.87C19.13 15.87 18.22 16.57 17.79 16.95L10.58 23.59C9.97 24.16 8.98 23.73 8.98 22.89V17.86C8.96 16.47 7.85 15.33 6.47 15.26H4.92C4.31 15.26 4.0 14.52 4.43 14.08L8.43 10.02C8.86 9.58 9.61 9.89 9.61 10.51V13.34C9.64 14.22 9.89 14.93 10.85 14.93C11.48 14.93 12.2 14.45 12.68 14.08L20.13 7.2Z", cy: 15.9, spread: 2.6, scale: 0.8, round: 1.8, brows: false, smallZoom: 1.26, eyes: [[13.4, 17.1], [17.4, 14.4]] },
];
const HUES = [217, 192, 158, 96, 38, 18, 248, 270, 200];

function hash(id: string) {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function faceOf(id: string) {
  const h = hash(id);
  return { shape: h % SHAPES.length, hue: HUES[(h >>> 4) % HUES.length]!, spread: 0.78 + ((h >>> 9) % 4) * 0.07, phase: (h >>> 13) % 1000 };
}

const INK = "#121216";
/** A face's own colours, for a face that wears a brand's rather than one from its id. */
export type Colors = { face: string; edge: string; line: string; ink: string };

const r1 = (n: number) => Math.round(n * 100) / 100;

/**
 * One eye's outline: a pill `w` wide and `h` tall that bends, as `smile` goes to 1, into a ^ (closed, happy), so every expression
 * is the same shape with different numbers and one can morph into the next. Turned by `angle` about its centre.
 */
function eyePath(cx: number, cy: number, w: number, h: number, angle: number, smile: number, k: number) {
  const N = 10;
  const r = Math.min(w, h) / 2;
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const x = (-w / 2) * Math.cos((Math.PI * i) / N);
    const u = (2 * x) / w;
    const a = Math.max(0, Math.abs(x) - (w / 2 - r));
    const hh = h / 2 - r + Math.sqrt(Math.max(0, r * r - a * a));
    const arc = (0.9 - 1.6 * (1 - u * u)) * k;
    const t = 2.1 * k * (0.5 + 0.5 * Math.sqrt(Math.max(0, 1 - u * u)));
    top.push([x, -hh + (arc - t / 2 + hh) * smile]);
    bottom.push([x, hh + (arc + t / 2 - hh) * smile]);
  }
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const pts = [...top, ...bottom.reverse()].map(([x, y]) => `${r1(cx + x * c - y * sn)} ${r1(cy + x * sn + y * c)}`);
  return `M${pts.join("L")}Z`;
}

type Geometry = { lx: number; ly: number; rx: number; ry: number; k: number; brows: boolean; small: boolean; face: string; back: string; line: string; round: boolean };

// Turning, the body is a slab DEPTH thick: the face plane narrows by cos θ, SLABS copies of the silhouette in the edge colour
// fill the side as it comes round (sin θ · DEPTH wide), and past 90° the plain back faces out instead, eyes hidden.
const DEPTH = 5;
const SLABS = 10;
const squash = (c: number, off: number) => `translate(${r1(16 + off)} 0) scale(${r1(Math.max(Math.abs(c), 0.015) * 1000) / 1000} 1) translate(-16 0)`;

/** Everything a frame sets on the face's elements, as attributes, so React draws the first and the ticker the rest. */
function paint(f: Frame, g: Geometry) {
  const { k } = g;
  const dx = f.gx * 1.5 * k;
  const dy = f.gy * 1.3 * k;
  const eye = (x: number, y: number, open: number, angle: number, far: number) => {
    const w = 3.2 * k * f.width * (1 - 0.14 * far);
    const h = Math.max(0.7 * k, 6 * k * open * Math.max(f.blink, f.smile > 0.5 ? 0.45 : 0));
    return eyePath(x + dx, y + dy, w, h, angle, f.smile, k);
  };
  const brow = (x: number, y: number, side: -1 | 1) => {
    const open = Math.max(f.leftOpen, f.rightOpen);
    const by = y + dy - 3 * k * Math.max(open, 0.6) - 1.4 * k - f.browLift * 1.5 * k + side * f.browAsym * 0.5 * k;
    const t = -f.browAngle * 2 * k * side;
    return `M${r1(x + dx - 2.1 * k)} ${r1(by - t)}L${r1(x + dx + 2.1 * k)} ${r1(by + t)}`;
  };
  const deg = (f.rot * 180) / Math.PI;
  const zCount = g.small ? 2 : 3;
  const c = Math.cos(f.turn);
  const side = Math.sin(f.turn) * DEPTH;
  return {
    cap: squash(c, (c >= 0 ? -side : side) / 2),
    capFill: c >= 0 ? g.face : g.back,
    eyes: r1(Math.max(0, Math.min(1, (c - 0.2) * 4))),
    slabs: Array.from({ length: SLABS }, (_, i) => squash(c, side * (i / (SLABS - 1) - 0.5))),
    head: `translate(${r1(f.x)} ${r1(f.y)}) rotate(${r1(deg)} 16 18) translate(16 27) scale(${r1(f.scale * 1000) / 1000}) translate(-16 -27)`,
    left: eye(g.lx, g.ly, f.leftOpen, f.leftAngle, Math.max(0, f.gx)),
    right: eye(g.rx, g.ry, f.rightOpen, f.rightAngle, Math.max(0, -f.gx)),
    browL: g.brows ? brow(g.lx, g.ly, -1) : "",
    browR: g.brows ? brow(g.rx, g.ry, 1) : "",
    browOpacity: r1(f.brow * 0.6),
    // Asleep, z's rise from beside the head and fade, one after another.
    zs: Array.from({ length: zCount }, (_, i) => {
      const t = (f.z + i / zCount) % 1;
      return { x: r1(g.rx + 3 + 3.5 * t + Math.sin(Math.PI * t)), y: r1(g.ry - 4 - 9 * t), o: f.z ? r1(0.85 * Math.sin(Math.PI * t) ** 1.5) : 0, s: r1((i % 2 ? 5 : 4) + 1.5 * t) };
    }),
  };
}

// The body's grain, as BoardUI's: grey white noise tiled one dot to a pixel at 64px and laid over the body in soft-light, so it
// shades whichever colour is under it, in light and dark alike. One 32×32 tile made once; faces drawn small leave it off, where it
// would only muddy them.
let grain = "";
function grainTile() {
  if (grain || typeof document === "undefined") return grain;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(32, 32);
  let seed = 713;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = seed >>> 24;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return (grain = c.toDataURL());
}
const GRAIN = { mixBlendMode: "soft-light", opacity: 0.45, pointerEvents: "none" } as const;

// A sleeping face's z, drawn as a path (as text it would be the page's text: copied, found by ⌘F), `size` units tall at x, y.
const Z = "M-1.3 -1.6H1.3L-1.3 1.6H1.3";
const zAt = (x: number, y: number, size: number) => `translate(${x} ${r1(y - size / 2)}) scale(${r1(size / 5.5)})`;

// Every living face on the page shares one animation frame loop: 60fps while any of them is mid-change or blinking, 30 while they
// only drift. It draws nothing while the tab is hidden, while the image viewer is open (data-viewing: a moving face under its scrim
// re-rastered the page beneath every frame) or for a face scrolled out of view.
type Live = { life: Life; target: () => Expression; geometry: Geometry; els: Els; visible: boolean };
type Els = { shadowClip: SVGPathElement | null; slabClips: SVGPathElement[]; cap: SVGGElement; shadow: SVGGElement; capFill: SVGPathElement; eyes: SVGGElement; slabs: SVGPathElement[]; head: SVGGElement; left: SVGPathElement; right: SVGPathElement; browL: SVGPathElement; browR: SVGPathElement; brows: SVGGElement; zs: SVGPathElement[] };
const live = new Set<Live>();
let frame = 0;
let last = 0;
let busy = true;

function apply(l: Live, f: Frame) {
  const p = paint(f, l.geometry);
  const { els } = l;
  els.head.setAttribute("transform", p.head);
  els.cap.setAttribute("transform", p.cap);
  els.shadow.setAttribute("transform", p.cap);
  els.shadowClip?.setAttribute("transform", `${p.cap} translate(1.1 1.5)`);
  els.capFill.setAttribute("fill", p.capFill);
  els.capFill.setAttribute("stroke", l.geometry.round ? p.capFill : l.geometry.line);
  els.eyes.setAttribute("opacity", String(p.eyes));
  p.slabs.forEach((t, i) => (els.slabs[i]?.setAttribute("transform", t), els.slabClips[i]?.setAttribute("transform", t)));
  els.left.setAttribute("d", p.left);
  els.right.setAttribute("d", p.right);
  els.browL.setAttribute("d", p.browL);
  els.browR.setAttribute("d", p.browR);
  els.brows.setAttribute("opacity", String(p.browOpacity));
  p.zs.forEach((z, i) => {
    const el = els.zs[i];
    if (!el) return;
    el.setAttribute("transform", zAt(z.x, z.y, z.s));
    el.setAttribute("opacity", String(z.o));
  });
}

function tick(t: number) {
  frame = live.size ? requestAnimationFrame(tick) : 0;
  if (!last) last = t;
  if (t - last < (busy ? 15 : 31)) return;
  const dt = Math.min(t - last, 64) / 1000;
  last = t;
  if (document.hidden || document.documentElement.hasAttribute("data-viewing")) return;
  busy = false;
  for (const l of live) {
    if (!l.visible) continue;
    const target = l.target();
    const f = step(l.life, target, dt);
    busy ||= l.life.blink.on || Object.values(l.life.vel).some(v => v !== 0) || target === "working" || target === "waiting" || target === "done";
    apply(l, f);
  }
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * `expression` sets the eyes and brows; `still` draws its resting pose and never moves (the favicon, lists of many faces); `small`
 * drops the brows, which blur below about 24px.
 */
export function AgentFace({ id, expression = "idle", still, small, shape, colors, className }: { id: string; expression?: Expression; still?: boolean; small?: boolean; shape?: string; colors?: Colors; className?: string }) {
  const f = faceOf(id);
  const body = SHAPES.find(x => x.name === shape) ?? SHAPES[f.shape]!;
  const k = body.scale ?? 1;
  const spread = body.spread * f.spread;
  const [[lx, ly], [rx, ry]] = body.eyes ?? [[16 - spread, body.cy], [16 + spread, body.cy]];
  const { face, edge, line, ink } = colors ?? { face: `hsl(${f.hue} 82% 83%)`, edge: `hsl(${f.hue} 52% 54%)`, line: `hsl(${f.hue} 48% 58%)`, ink: INK };
  const r = body.round ?? 0;
  const geometry: Geometry = { lx, ly, rx, ry, k, brows: !small && body.brows !== false, small: !!small, face, back: line, line, round: r > 0 };

  const uid = useId().replace(/:/g, "");
  const tile = small ? "" : grainTile();
  // A living face is drawn by React once, in the pose it starts in; after that only the ticker touches its eyes, so a new
  // expression springs from wherever they are rather than jumping.
  const first = useRef(expression);
  const now = useRef(expression);
  now.current = expression;
  const animated = !still;
  const mount = useCallback((el: SVGSVGElement) => {
    if (!animated || reduced()) return;
    const q = <T extends Element>(s: string) => el.querySelector(s) as T;
    const me: Live = {
      life: createLife(hash(id) ^ (Math.random() * 2 ** 32), first.current),
      target: () => now.current,
      geometry,
      visible: true,
      els: { shadowClip: q("[data-face=shadow-clip]"), slabClips: [...el.querySelectorAll("[data-face=slab-clip]")] as SVGPathElement[], cap: q("[data-face=cap]"), shadow: q("[data-face=shadow]"), capFill: q("[data-face=cap-fill]"), eyes: q("[data-face=eyes]"), slabs: [...el.querySelectorAll("[data-face=slab]")] as SVGPathElement[], head: q("[data-face=head]"), left: q("[data-face=left]"), right: q("[data-face=right]"), browL: q("[data-face=brow-l]"), browR: q("[data-face=brow-r]"), brows: q("[data-face=brows]"), zs: [...el.querySelectorAll("[data-face=z]")] as SVGPathElement[] },
    };
    live.add(me);
    busy = true;
    if (!frame) (last = 0), (frame = requestAnimationFrame(tick));
    const io = new IntersectionObserver(([e]) => (me.visible = !!e?.isIntersecting));
    io.observe(el);
    return () => {
      io.disconnect();
      live.delete(me);
    };
  }, [animated, id, shape, small]);

  const p = paint(restFrame(animated ? first.current : expression), geometry);
  return (
    <svg ref={mount} viewBox="0 0 32 32" aria-hidden overflow="visible" className={cn("agent-face shrink-0", className)}>
      <g data-face="head" transform={p.head}>
        <g transform={small && body.smallZoom ? `translate(16 16) scale(${body.smallZoom}) translate(-16 -16)` : undefined}>
          <g data-face="shadow" transform={p.cap}>
            <path d={body.d} transform="translate(1.1 1.5)" fill={edge} stroke={edge} strokeWidth={r} strokeLinejoin="round" />
          </g>
          {tile && (
            <defs>
              <pattern id={`${uid}g`} patternUnits="userSpaceOnUse" width="8" height="8">
                <image href={tile} width="8" height="8" style={{ imageRendering: "pixelated" }} />
              </pattern>
              <clipPath id={`${uid}b`}>
                <path d={body.d} />
              </clipPath>
              {/* The edge: the depth behind the body, and the side's slabs while it turns. */}
              <clipPath id={`${uid}s`}>
                <path data-face="shadow-clip" d={body.d} transform={`${p.cap} translate(1.1 1.5)`} />
                {animated &&
                  p.slabs.map((t, i) => (
                    <path key={i} data-face="slab-clip" d={body.d} transform={t} />
                  ))}
              </clipPath>
            </defs>
          )}
          {animated && p.slabs.map((t, i) => <path key={i} data-face="slab" d={body.d} transform={t} fill={edge} stroke={edge} strokeWidth={r + 0.8} strokeLinejoin="round" />)}
          {tile && <rect x="-4" y="-4" width="40" height="40" fill={`url(#${uid}g)`} clipPath={`url(#${uid}s)`} style={GRAIN} />}
          <g data-face="cap" transform={p.cap}>
            {r > 0 && <path d={body.d} fill="none" stroke={line} strokeWidth={r + 1.4} strokeLinejoin="round" />}
            <path data-face="cap-fill" d={body.d} fill={p.capFill} stroke={r > 0 ? p.capFill : line} strokeWidth={r || 0.7} strokeLinejoin="round" />
            {tile && <rect x="-4" y="-4" width="40" height="40" fill={`url(#${uid}g)`} clipPath={`url(#${uid}b)`} style={GRAIN} />}
            <g data-face="eyes" opacity={p.eyes}>
              <path data-face="left" d={p.left} fill={ink} />
              <path data-face="right" d={p.right} fill={ink} />
              <g data-face="brows" opacity={p.browOpacity} stroke={ink} strokeWidth={1.2 * k} strokeLinecap="round" fill="none">
                <path data-face="brow-l" d={p.browL} />
                <path data-face="brow-r" d={p.browR} />
              </g>
            </g>
          </g>
        </g>
      </g>
      {(expression === "asleep" || animated) &&
        p.zs.map((z, i) => (
          <path key={i} data-face="z" d={Z} transform={still ? zAt(rx + 3 + i * 3, ry - 4 - i * 4, z.s) : zAt(z.x, z.y, z.s)} opacity={still && expression === "asleep" ? 0.7 - i * 0.2 : z.o} fill="none" stroke={ink} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        ))}
    </svg>
  );
}

/** Every body an agent can have, by name. */
export const SHAPE_NAMES = SHAPES.map(x => x.name);

/** What an agent's state looks like on its face. */
export const expressionOf = (state?: string): Expression => (state === "working" ? "working" : state === "waiting" ? "waiting" : state === "asleep" ? "asleep" : "idle");
