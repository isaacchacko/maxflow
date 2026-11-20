import { useCallback, useEffect, useRef, useState } from "react";

// screen = world * z + (x, y)
export type Camera = { x: number; y: number; z: number };
export type Rect = { x: number; y: number; width: number; height: number };

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const FLY_MS = 520;
const FIT_MARGIN = 120;

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

export function useCamera(viewport: React.RefObject<HTMLDivElement | null>) {
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, z: 1 });
  const flight = useRef(0);
  const live = useRef(camera);
  live.current = camera;

  const stopFlying = () => cancelAnimationFrame(flight.current);
  const panBy = useCallback((dx: number, dy: number) => {
    stopFlying();
    setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
  }, []);
  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    stopFlying();
    setCamera((c) => {
      const z = clampZoom(c.z * factor);
      return { z, x: px - ((px - c.x) * z) / c.z, y: py - ((py - c.y) * z) / c.z };
    });
  }, []);
  const flyTo = useCallback((goal: Camera) => {
    stopFlying();
    const from = live.current;
    const start = performance.now();
    const tick = (now: number) => {
      const t = easeInOut(Math.min(1, (now - start) / FLY_MS));
      setCamera({ x: from.x + (goal.x - from.x) * t, y: from.y + (goal.y - from.y) * t, z: from.z + (goal.z - from.z) * t });
      if (t < 1) flight.current = requestAnimationFrame(tick);
    };
    flight.current = requestAnimationFrame(tick);
  }, []);
  const centerOn = useCallback(
    (box: Rect) => {
      const el = viewport.current;
      if (!el) return;
      const z = Math.max(live.current.z, 0.8);
      flyTo({ z, x: el.clientWidth / 2 - (box.x + box.width / 2) * z, y: el.clientHeight / 2 - (box.y + box.height / 2) * z });
    },
    [flyTo, viewport],
  );

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    // constraint: React's onWheel is passive, and only a non-passive listener can stop the page from scrolling or zooming
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
      else panBy(-e.deltaX, -e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewport, panBy, zoomAt]);

  return { camera, setCamera, panBy, zoomAt, flyTo, centerOn };
}
