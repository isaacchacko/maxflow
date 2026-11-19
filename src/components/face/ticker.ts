import { paint, zAt, type Geometry } from "./paint";
import { step, type Expression, type Frame, type Life } from "./rig";

type Els = {
  shadowClip: SVGPathElement | null;
  slabClips: SVGPathElement[];
  cap: SVGGElement;
  shadow: SVGGElement;
  capFill: SVGPathElement;
  eyes: SVGGElement;
  slabs: SVGPathElement[];
  head: SVGGElement;
  left: SVGPathElement;
  right: SVGPathElement;
  browL: SVGPathElement;
  browR: SVGPathElement;
  brows: SVGGElement;
  zs: SVGPathElement[];
};
export type LiveFace = { life: Life; target: () => Expression; geometry: Geometry; els: Els; visible: boolean };

const live = new Set<LiveFace>();
const ticker = { frame: 0, last: 0, isBusy: true };

function faceGroup(svg: SVGSVGElement, name: string) {
  return svg.querySelector<SVGGElement>(`[data-face=${CSS.escape(name)}]`);
}

function facePath(svg: SVGSVGElement, name: string) {
  return svg.querySelector<SVGPathElement>(`[data-face=${CSS.escape(name)}]`);
}

const facePaths = (svg: SVGSVGElement, name: string) => [...svg.querySelectorAll<SVGPathElement>(`[data-face=${CSS.escape(name)}]`)];

export function faceElements(svg: SVGSVGElement): Els | undefined {
  const [cap, shadow, eyes, head, brows] = ["cap", "shadow", "eyes", "head", "brows"].map(name => faceGroup(svg, name));
  const [capFill, left, right, browL, browR] = ["cap-fill", "left", "right", "brow-l", "brow-r"].map(name => facePath(svg, name));
  if (!cap || !shadow || !eyes || !head || !brows || !capFill || !left || !right || !browL || !browR) return undefined;
  return { shadowClip: facePath(svg, "shadow-clip"), slabClips: facePaths(svg, "slab-clip"), cap, shadow, capFill, eyes, slabs: facePaths(svg, "slab"), head, left, right, browL, browR, brows, zs: facePaths(svg, "z") };
}

function apply(face: LiveFace, f: Frame) {
  const { geometry } = face;
  const p = paint(f, geometry);
  const { els } = face;
  els.head.setAttribute("transform", p.head);
  els.cap.setAttribute("transform", p.cap);
  els.shadow.setAttribute("transform", p.cap);
  els.shadowClip?.setAttribute("transform", `${p.cap} translate(1.1 1.5)`);
  els.capFill.setAttribute("fill", p.capFill);
  els.capFill.setAttribute("stroke", geometry.round ? p.capFill : geometry.line);
  els.eyes.setAttribute("opacity", String(p.eyes));
  for (const [i, t] of p.slabs.entries()) {
    els.slabs[i]?.setAttribute("transform", t);
    els.slabClips[i]?.setAttribute("transform", t);
  }
  els.left.setAttribute("d", p.left);
  els.right.setAttribute("d", p.right);
  els.browL.setAttribute("d", p.browL);
  els.browR.setAttribute("d", p.browR);
  els.brows.setAttribute("opacity", String(p.browOpacity));
  for (const [i, z] of p.zs.entries()) {
    const el = els.zs[i];
    if (!el) continue;
    el.setAttribute("transform", zAt(z.x, z.y, z.s));
    el.setAttribute("opacity", String(z.o));
  }
}

const isStillMoving = (face: LiveFace, target: Expression) =>
  face.life.blink.on || Object.values(face.life.vel).some(v => v !== 0) || target === "working" || target === "waiting" || target === "done";

function stepVisibleFaces(dt: number) {
  ticker.isBusy = false;
  for (const face of live) {
    if (!face.visible) continue;
    const target = face.target();
    const f = step(face.life, target, dt);
    ticker.isBusy ||= isStillMoving(face, target);
    apply(face, f);
  }
}

const isDrawingPaused = () => document.hidden || document.documentElement.dataset["viewing"] !== undefined;

function tick(t: number) {
  ticker.frame = live.size > 0 ? requestAnimationFrame(tick) : 0;
  if (ticker.last === 0) ticker.last = t;
  if (t - ticker.last < (ticker.isBusy ? 15 : 31)) return;
  const dt = Math.min(t - ticker.last, 64) / 1000;
  ticker.last = t;
  if (isDrawingPaused()) return;
  stepVisibleFaces(dt);
}

export function startLiving(face: LiveFace) {
  live.add(face);
  ticker.isBusy = true;
  if (ticker.frame === 0) {
    ticker.last = 0;
    ticker.frame = requestAnimationFrame(tick);
  }
  return () => {
    live.delete(face);
  };
}
