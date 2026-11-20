import { useRef, useState } from "react";
import { useEventListener, useLatest } from "@/lib/effects";

export type Camera = { x: number; y: number; z: number };
export type Rect = { x: number; y: number; width: number; height: number };

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const FLY_MS = 520;
const FIT_MARGIN = 120;
const START: Camera = { x: 0, y: 0, z: 1 };

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function fitting(boxes: Rect[], width: number, height: number): Camera {
  if (boxes.length === 0) return { x: width / 2 - 130, y: height / 3, z: 1 };
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const z = clampZoom(Math.min(1, width / (right - left + FIT_MARGIN), height / (bottom - top + FIT_MARGIN)));
  return { x: width / 2 - ((left + right) / 2) * z, y: height / 2 - ((top + bottom) / 2) * z, z };
}

export function useCamera(el: HTMLElement | null) {
  const [placed, setCamera] = useState<Camera | undefined>();
  const latest = useLatest(placed ?? START);
  const flight = useRef(0);
  const stopFlying = () => cancelAnimationFrame(flight.current);

  const panBy = (dx: number, dy: number) => {
    stopFlying();
    setCamera((c = START) => ({ ...c, x: c.x + dx, y: c.y + dy }));
  };
  const zoomAt = (px: number, py: number, factor: number) => {
    stopFlying();
    setCamera((c = START) => {
      const z = clampZoom(c.z * factor);
      return { z, x: px - ((px - c.x) * z) / c.z, y: py - ((py - c.y) * z) / c.z };
    });
  };
  const flyTo = (goal: Camera) => {
    stopFlying();
    const from = latest.current;
    const start = performance.now();
    const tick = (now: number) => {
      const t = easeInOut(Math.min(1, (now - start) / FLY_MS));
      setCamera({ x: from.x + (goal.x - from.x) * t, y: from.y + (goal.y - from.y) * t, z: from.z + (goal.z - from.z) * t });
      if (t < 1) flight.current = requestAnimationFrame(tick);
    };
    flight.current = requestAnimationFrame(tick);
  };
  const centerOn = (box: Rect) => {
    if (!el) return;
    const z = Math.max(latest.current.z, 0.8);
    flyTo({ z, x: el.clientWidth / 2 - (box.x + box.width / 2) * z, y: el.clientHeight / 2 - (box.y + box.height / 2) * z });
  };

  // constraint: only a listener on the element itself, not React's passive onWheel, can stop the page from scrolling or zooming
  useEventListener(
    "wheel",
    (e) => {
      if (!el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
      else panBy(-e.deltaX, -e.deltaY);
    },
    { target: el },
  );

  return { camera: placed ?? START, isPlaced: placed !== undefined, setCamera, panBy, zoomAt, centerOn };
}
