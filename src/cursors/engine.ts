import { createStore } from "@/store";
import { along, clampInto, clipBox, degreesToward, distance, easeInOut, elementsFor, flightMs, isInside, isShown, tipOf, type Point } from "./geometry";
import { onCursor, tuningStore, type CursorEvent } from "./store";

export type Shown = { agent: string; name: string; action: string };
type Rig = { root: HTMLElement; arrow: HTMLElement; pulse: HTMLElement; edge: HTMLElement; pointer: HTMLElement };
type Flight = { from: Point | undefined; bend: number; start: number; targets: string[]; hasPulsed: boolean };
type Cursor = { pos: Point | undefined; flight: Flight; lastAt: number; rig?: Rig };

const EDGE_INSET = 18;
const ARRIVE_FROM = { x: 36, y: 52 };
const PULSE_MS = 520;

export const shownCursorsStore = createStore<Shown[]>([]);
const cursors = new Map<string, Cursor>();

const motionReduced = () => tuningStore.get().isMotionReduced || matchMedia("(prefers-reduced-motion: reduce)").matches;

function targetOf(targets: string[]) {
  const all = targets.flatMap(id => [...elementsFor(id)]).filter(el => isShown(el));
  return all.find(el => isInside(tipOf(el.getBoundingClientRect()), clipBox(el))) ?? all[0];
}

function aim(e: CursorEvent) {
  const was = cursors.get(e.agent);
  const bendSign = (was?.flight.bend ?? 1) > 0 ? -1 : 1;
  const flight = { from: was?.pos, bend: bendSign * tuningStore.get().arc, start: performance.now(), targets: e.targets, hasPulsed: false };
  if (was) Object.assign(was, { flight, lastAt: performance.now() });
  else cursors.set(e.agent, { pos: undefined, flight, lastAt: performance.now() });
  const shown = { agent: e.agent, name: e.name, action: e.action };
  shownCursorsStore.set(all => (all.some(x => x.agent === e.agent) ? all.map(x => (x.agent === e.agent ? shown : x)) : [...all, shown]));
}

function pulse(rig: Rig) {
  const frames = motionReduced()
    ? [{ opacity: 0.6 }, { opacity: 0 }]
    : [
        { transform: "translate(-50%, -50%) scale(0.2)", opacity: 0.55 },
        { transform: "translate(-50%, -50%) scale(1.9)", opacity: 0 },
      ];
  rig.pulse.animate(frames, { duration: PULSE_MS, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" });
}

function progress(c: Cursor, from: Point, goal: Point, now: number) {
  if (motionReduced()) return 1;
  const ms = flightMs(distance(from, goal), tuningStore.get().speed);
  return Math.min(1, Math.max(0, (now - c.flight.start) / ms));
}

function place(rig: Rig, part: "arrow" | "edge", at: Point) {
  rig.arrow.style.display = part === "arrow" ? "" : "none";
  rig.edge.style.display = part === "edge" ? "" : "none";
  rig[part].style.transform = `translate(${at.x}px, ${at.y}px)`;
}

function onScreen(c: Cursor, rig: Rig, goal: Point, now: number) {
  const from = c.flight.from ?? { x: goal.x + ARRIVE_FROM.x, y: goal.y + ARRIVE_FROM.y };
  const t = progress(c, from, goal, now);
  c.pos = along(from, goal, c.flight.bend, easeInOut(t));
  place(rig, "arrow", c.pos);
  if (t < 1 || c.flight.hasPulsed) return;
  c.flight.hasPulsed = true;
  pulse(rig);
}

function offScreen(c: Cursor, rig: Rig, goal: Point, el: Element) {
  const at = clampInto(goal, clipBox(el), EDGE_INSET);
  c.pos = at;
  place(rig, "edge", at);
  rig.pointer.style.transform = `rotate(${degreesToward(at, goal)}deg)`;
}

function step(c: Cursor, now: number) {
  const { rig } = c;
  if (!rig) return;
  const isAwake = now - c.lastAt < tuningStore.get().idleSeconds * 1000;
  const el = isAwake ? targetOf(c.flight.targets) : undefined;
  rig.root.style.opacity = el ? "1" : "0";
  rig.root.style.transitionDuration = el ? "150ms" : "700ms";
  if (!el) return;
  const goal = tipOf(el.getBoundingClientRect());
  if (isInside(goal, clipBox(el))) onScreen(c, rig, goal, now);
  else offScreen(c, rig, goal, el);
}

export function rigCursor(agent: string, root: HTMLElement) {
  const part = (name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`);
  const [arrow, pulseEl, edge, pointer] = [part("arrow"), part("pulse"), part("edge"), part("pointer")];
  const c = cursors.get(agent);
  if (!c || !arrow || !pulseEl || !edge || !pointer) return undefined;
  c.rig = { root, arrow, pulse: pulseEl, edge, pointer };
  return () => {
    if (c.rig?.root === root) delete c.rig;
  };
}

export function runCursors() {
  let frame = requestAnimationFrame(function tick(now) {
    for (const c of cursors.values()) step(c, now);
    frame = requestAnimationFrame(tick);
  });
  const stopListening = onCursor(aim);
  return () => {
    cancelAnimationFrame(frame);
    stopListening();
  };
}
