import { useState } from "react";

const MIN = 1;
const MAX = 8;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));
const UNZOOMED = { s: 1, x: 0, y: 0 };

type Zoom = { s: number; x: number; y: number };

const holdPageStill = (isHeld: boolean) => {
  document.documentElement.toggleAttribute("data-viewing", isHeld);
};

function centredOn(el: Element, clientX: number, clientY: number) {
  const r = el.getBoundingClientRect();
  return { px: clientX - r.left - r.width / 2, py: clientY - r.top - r.height / 2 };
}

function dragHandlers(zoomNow: () => Zoom, panTo: (zoom: Zoom) => void) {
  const dragging: { drag: { x: number; y: number; moved?: boolean } | null } = { drag: null };

  const onStageClick = (e: React.MouseEvent, close: () => void) => {
    // constraint: pointer capture lands a drag's click on the scrim, and a drag that moved must not close the viewer
    if (dragging.drag?.moved === true) {
      dragging.drag = null;
      return;
    }
    if (e.target === e.currentTarget) close();
  };

  const startDrag = (e: React.PointerEvent) => {
    const zoom = zoomNow();
    if (zoom.s <= 1 || e.target === e.currentTarget) return;
    dragging.drag = { x: e.clientX - zoom.x, y: e.clientY - zoom.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragging.drag;
    if (!d || e.buttons === 0) return;
    d.moved = true;
    panTo({ ...zoomNow(), x: e.clientX - d.x, y: e.clientY - d.y });
  };

  const endDrag = () => {
    if (dragging.drag?.moved !== true) dragging.drag = null;
  };

  return { onStageClick, startDrag, moveDrag, endDrag };
}

function createZoom(setZoomed: (isZoomed: boolean) => void) {
  const state: { zoom: Zoom; img: HTMLImageElement | null; stage: HTMLDivElement | null; frame: number; settle: ReturnType<typeof setTimeout> | undefined } = { zoom: UNZOOMED, img: null, stage: null, frame: 0, settle: undefined };

  // constraint: a pinch sends hundreds of wheel events a second, so zoom reaches the img as one transform per frame, never through a render
  const apply = (isEased = false) => {
    setZoomed(state.zoom.s > 1);
    const el = state.img;
    if (!el) return;
    el.style.transition = isEased ? "transform 150ms ease-out" : "none";
    el.style.willChange = "transform";
    clearTimeout(state.settle);
    state.settle = setTimeout(() => {
      el.style.willChange = "";
    }, 300);
    if (state.frame !== 0) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      const { s, x, y } = state.zoom;
      el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
    });
  };

  const reset = (isEased = false) => {
    state.zoom = UNZOOMED;
    apply(isEased);
  };

  const zoomBy = (k: number, px = 0, py = 0, isEased = false) => {
    const z = state.zoom;
    const s = clamp(z.s * k);
    const r = s / z.s;
    state.zoom = s === 1 ? { s, x: 0, y: 0 } : { s, x: px - (px - z.x) * r, y: py - (py - z.y) * r };
    apply(isEased);
  };

  const attachImg = (el: HTMLImageElement | null) => {
    state.img = el;
    if (el) reset();
  };

  const attachStage = (el: HTMLDivElement) => {
    state.stage = el;
    holdPageStill(true);
    // constraint: React's wheel listener is passive, and a pinch arrives as a ctrl-wheel that would zoom the whole page
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { px, py } = centredOn(el, e.clientX, e.clientY);
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), px, py);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      holdPageStill(false);
      cancelAnimationFrame(state.frame);
      clearTimeout(state.settle);
      state.frame = 0;
      state.stage = null;
    };
  };

  const toggleAt = (clientX: number, clientY: number) => {
    if (!state.stage) return;
    const { px, py } = centredOn(state.stage, clientX, clientY);
    if (state.zoom.s > 1) reset(true);
    else zoomBy(2.5, px, py, true);
  };

  const panTo = (zoom: Zoom) => {
    state.zoom = zoom;
    apply();
  };
  return { reset, zoomBy, attachImg, attachStage, toggleAt, ...dragHandlers(() => state.zoom, panTo) };
}

export function useZoom() {
  const [isZoomed, setZoomed] = useState(false);
  const [zoom] = useState(() => createZoom(setZoomed));
  return { ...zoom, isZoomed };
}
