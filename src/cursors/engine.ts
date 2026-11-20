import { faceOf } from "@/components/AgentFace";
import { createStore } from "@/store";
import { along, distance, easeInOut, edgePoint, flightMs, isVisible, planePoint, spotIn, tipOf, visibleOf, type Point } from "./geometry";
import { hold } from "./holds";
import { typeIntoDoc } from "./doc-typing";
import { onCursor, tuningStore, type CursorEvent } from "./store";

export type Shown = { agent: string; name: string; action: string };
export type Rig = { root: HTMLElement; arrow: HTMLElement; tip: HTMLElement; caret: HTMLElement; ghost: HTMLElement };
type Cursor = { pos: Point | undefined; bend: number; run: number; seenUntil: number; rig?: Rig };

const HOLD_CAP_MS = 1200;
const FLIGHT_BUDGET_MS = 950;
const RIG_WAIT_MS = 250;
const APPEAR_WAIT_MS = 900;
const DRIFT = { x: 10, y: 8 };
const FADE_MS = 600;
const LINGER_MS = 260;

export const colorOf = (agent: string) => `hsl(${faceOf(agent).hue} 62% 48%)`;
export const shownCursorsStore = createStore<Shown[]>([]);
const cursors = new Map<string, Cursor>();

class Cancelled extends Error {}

const isMotionReduced = () => tuningStore.get().isMotionReduced || matchMedia("(prefers-reduced-motion: reduce)").matches;
const nextFrame = async () => new Promise<number>(resolve => requestAnimationFrame(resolve));

async function didFinish(animation: Animation | undefined) {
  try {
    await animation?.finished;
    return true;
  } catch {
    return false;
  }
}

function check(c: Cursor, run: number) {
  if (c.run !== run) throw new Cancelled();
}

async function waitFor<T>(c: Cursor, run: number, ms: number, find: () => T | undefined) {
  const until = performance.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined || performance.now() > until) return found;
    await nextFrame();
    check(c, run);
  }
}

async function pause(c: Cursor, run: number, ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    await nextFrame();
    check(c, run);
  }
}

async function frames(c: Cursor, run: number, ms: number, each: (t: number) => void) {
  const start = performance.now();
  for (let t = 0; t < 1; ) {
    const now = await nextFrame();
    check(c, run);
    t = ms <= 0 ? 1 : Math.min(1, (now - start) / ms);
    each(t);
  }
}

function place(c: Cursor, at: Point) {
  Object.assign(c, { pos: at });
  c.rig?.arrow.style.setProperty("transform", `translate(${at.x}px, ${at.y}px)`);
}

function showLabel(e: CursorEvent) {
  const shown = { agent: e.agent, name: e.name, action: e.action };
  shownCursorsStore.set(all => (all.some(x => x.agent === e.agent) ? all.map(x => (x.agent === e.agent ? shown : x)) : [...all, shown]));
}

const AGENT_PLACES = (agent: string) => [`[data-node="agent:${agent}"]`, `[data-node="router:${agent}"]`, ...[`agent:${agent}`, `agent-name:${agent}`, `agent-link:${agent}`].map(id => `[data-agent="${CSS.escape(id)}"]`)];

function startOf(c: Cursor, agent: string, goal: Point) {
  if (c.pos && performance.now() < c.seenUntil) return c.pos;
  const face = AGENT_PLACES(agent)
    .flatMap(sel => [...document.querySelectorAll(sel)])
    .find(el => isVisible(el));
  return face ? tipOf(face.getBoundingClientRect()) : edgePoint(goal);
}

async function fly(c: Cursor, run: number, goal: () => Point, ms: number) {
  const from = c.pos ?? goal();
  Object.assign(c, { bend: (c.bend > 0 ? -1 : 1) * tuningStore.get().arc });
  await frames(c, run, ms, t => place(c, along(from, goal(), c.bend, easeInOut(t))));
}

async function flyTo(c: Cursor, run: number, goal: () => Point) {
  const at = goal();
  await fly(c, run, goal, Math.min(FLIGHT_BUDGET_MS, legMs(c.pos ?? at, at)));
}

async function press(c: Cursor) {
  await didFinish(c.rig?.tip.animate([{ transform: "scale(1)" }, { transform: "scale(0.8)" }, { transform: "scale(1)" }], { duration: 160, easing: "ease-out" }));
}

const pointOf = (ids: string[], at: (el: Element) => Point = el => tipOf(el.getBoundingClientRect())) => () => {
  const el = visibleOf(ids);
  return el ? at(el) : undefined;
};

function goalOf(find: () => Point | undefined, first: Point) {
  let at = first;
  return () => {
    at = find() ?? at;
    return at;
  };
}

function legMs(from: Point, to: Point) {
  return flightMs(distance(from, to), tuningStore.get().speed);
}

function ghostOf(rig: Rig, source: Element | undefined, carry: string | undefined) {
  if (source && carry === undefined) {
    const r = source.getBoundingClientRect();
    const ghost = source.cloneNode(true) as HTMLElement;
    for (const el of [ghost, ...ghost.querySelectorAll<HTMLElement>("[data-agent]")]) delete el.dataset["agent"];
    Object.assign(ghost.style, { position: "absolute", left: "0", top: "0", width: `${r.width}px`, height: `${r.height}px`, margin: "0", opacity: "0.85" });
    ghost.className += " rounded-md bg-background shadow-lg ring-1 ring-black/10";
    rig.ghost.replaceChildren(ghost);
    return { el: ghost, offset: { x: r.left, y: r.top } };
  }
  if (carry === undefined) return;
  const pill = document.createElement("span");
  pill.textContent = carry;
  pill.className = "absolute top-0 left-0 max-w-56 truncate rounded-full border bg-background px-2.5 py-0.5 text-xs shadow-lg";
  rig.ghost.replaceChildren(pill);
  return { el: pill, offset: undefined };
}

type Ghost = NonNullable<ReturnType<typeof ghostOf>>;

async function dropGhost(ghost: Ghost) {
  await didFinish(ghost.el.animate([{ opacity: 0.85 }, { opacity: 0, transform: `${ghost.el.style.transform} scale(0.9)` }], { duration: 180, fill: "forwards" }));
  ghost.el.remove();
}

function ghostFollower(c: Cursor, ghost: Ghost | undefined) {
  const grabbedAt = c.pos ?? { x: 0, y: 0 };
  return () => {
    if (!ghost || !c.pos) return;
    const at = ghost.offset ? { x: ghost.offset.x + c.pos.x - grabbedAt.x, y: ghost.offset.y + c.pos.y - grabbedAt.y } : { x: c.pos.x + 14, y: c.pos.y + 18 };
    ghost.el.style.setProperty("transform", `translate(${at.x}px, ${at.y}px) rotate(-1.5deg)`);
  };
}

async function carryTo(c: Cursor, run: number, e: CursorEvent, leg: { to: () => Point; ms: number }) {
  const { to, ms } = leg;
  const source = visibleOf(e.from ?? []);
  const ghost = c.rig ? ghostOf(c.rig, source, e.carry) : undefined;
  const follow = ghostFollower(c, ghost);
  const lift = source?.animate([{ opacity: 1 }, { opacity: 0.35 }], { duration: 120, fill: "forwards" });
  follow();
  try {
    const from = c.pos ?? to();
    await frames(c, run, ms, t => {
      place(c, along(from, to(), c.bend, easeInOut(t)));
      follow();
    });
    await press(c);
  } finally {
    lift?.cancel();
    if (ghost) void dropGhost(ghost);
  }
}

function dropPointOf(e: CursorEvent, source: Element | undefined) {
  const { onPlane } = e;
  if (!onPlane || !source) return pointOf(e.to);
  const r = source.getBoundingClientRect();
  const grab = tipOf(r);
  return () => {
    const plane = visibleOf(e.to);
    const at = plane ? planePoint(plane, onPlane) : undefined;
    return at ? { x: at.x + grab.x - r.left, y: at.y + grab.y - r.top } : undefined;
  };
}

function spotOf(e: CursorEvent) {
  const { onPlane } = e;
  return (into: Element) => (onPlane ? planePoint(into, { x: onPlane.x + 12, y: onPlane.y + 12 }) : undefined) ?? spotIn(into);
}

async function drag(c: Cursor, run: number, e: CursorEvent, release: () => void) {
  const source = visibleOf(e.from ?? []);
  const to = goalOf(dropPointOf(e, source), c.pos ?? { x: 0, y: 0 });
  const grab = source ? goalOf(pointOf(e.from ?? []), tipOf(source.getBoundingClientRect())) : undefined;
  const start = c.pos ?? to();
  const [reachMs, carryMs]: [number, number] = grab ? [legMs(start, grab()), legMs(grab(), to())] : [0, legMs(start, to())];
  const scale = Math.min(1, FLIGHT_BUDGET_MS / (reachMs + carryMs));
  if (grab) {
    await fly(c, run, grab, reachMs * scale);
    await press(c);
  }
  try {
    await carryTo(c, run, e, { to, ms: carryMs * scale });
  } finally {
    release();
  }
  const landed = await waitFor(c, run, 300, () => visibleOf(e.to));
  landed?.animate([{ boxShadow: `0 0 0 2px ${colorOf(e.agent)}` }, { boxShadow: "0 0 0 2px transparent" }], { duration: 700, easing: "ease-out" });
}

function textBox(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  return r.width > 0 ? { left: Math.max(r.left, box.left), right: Math.min(r.right, box.right), top: box.top, height: Math.min(box.height, r.height) } : { left: box.left, right: box.right, top: box.top, height: box.height };
}

async function typeIn(c: Cursor, run: number, el: HTMLElement, text: string) {
  const caret = c.rig?.caret;
  const steps = Math.max(1, Math.min(text.length, 48));
  const box = el.getBoundingClientRect();
  const shown = textBox(el);
  try {
    await frames(c, run, Math.min(900, Math.max(260, text.length * 30)), t => {
      const p = Math.ceil(t * steps) / steps;
      const edge = shown.left + (shown.right - shown.left) * p;
      el.style.setProperty("clip-path", `inset(-4px ${Math.max(0, box.right - edge)}px -4px -4px)`);
      caret?.style.setProperty("transform", `translate(${edge + 1}px, ${shown.top + (box.height - shown.height) / 2}px)`);
      caret?.style.setProperty("height", `${shown.height}px`);
      caret?.style.setProperty("opacity", "1");
    });
  } finally {
    el.style.removeProperty("clip-path");
    caret?.style.setProperty("opacity", "0");
  }
}

const ONE_LINE_PX = 48;

function lineWith(el: HTMLElement, text: string) {
  const isOneLine = (x: HTMLElement) => x.getBoundingClientRect().height <= ONE_LINE_PX;
  if (isOneLine(el)) return el;
  return el.querySelectorAll<HTMLElement>("*").values().find(x => x.textContent === text && isOneLine(x));
}

async function edit(c: Cursor, run: number, e: CursorEvent, release: () => void) {
  const target = visibleOf(e.to);
  if (!target) return;
  const tip = tipOf(target.getBoundingClientRect());
  await flyTo(c, run, goalOf(pointOf(e.to), tip));
  await press(c);
  const before = target.textContent;
  if (target.querySelector(".cm-editor")) {
    const moveTo = async (at: Point) => fly(c, run, () => at, legMs(c.pos ?? at, at) * 0.6);
    await typeIntoDoc(target, { release, typeIn: async (el, text) => typeIn(c, run, el, text), moveTo, check: () => check(c, run) });
    return;
  }
  release();
  await nextFrame();
  await nextFrame();
  check(c, run);
  const after = visibleOf(e.to);
  if (!(after instanceof HTMLElement)) return;
  const text = after.textContent;
  const line = text === before ? undefined : lineWith(after, text);
  if (line) await typeIn(c, run, line, text);
  else after.animate([{ backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)" }, { backgroundColor: "transparent" }], { duration: 600, easing: "ease-out" });
}

async function create(c: Cursor, run: number, e: CursorEvent, release: () => void) {
  const into = visibleOf(e.into ?? []);
  if (!into) return;
  const spot = spotOf(e);
  await flyTo(c, run, goalOf(pointOf(e.into ?? [], spot), spot(into)));
  await press(c);
  release();
  const made = await waitFor(c, run, APPEAR_WAIT_MS, () => visibleOf(e.to));
  if (!made || !c.pos) return;
  const r = made.getBoundingClientRect();
  const origin = `${c.pos.x - r.left}px ${c.pos.y - r.top}px`;
  made.animate(
    [
      { opacity: 0, transform: "scale(0.85)", transformOrigin: origin },
      { opacity: 1, transform: "scale(1)", transformOrigin: origin },
    ],
    { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
  );
}

async function remove(c: Cursor, run: number, e: CursorEvent, release: () => void) {
  const target = visibleOf(e.to);
  if (!target) return;
  const tip = tipOf(target.getBoundingClientRect());
  await flyTo(c, run, goalOf(pointOf(e.to), tip));
  await press(c);
  const collapse = target.animate(
    [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: "scale(0.88)" },
    ],
    { duration: 220, easing: "ease-in", fill: "forwards" },
  );
  try {
    await didFinish(collapse);
    release();
  } finally {
    setTimeout(() => collapse.cancel(), 400);
  }
}

async function fadeOut(c: Cursor, run: number) {
  await pause(c, run, LINGER_MS);
  const from = c.pos;
  c.rig?.root.style.setProperty("opacity", "0");
  Object.assign(c, { seenUntil: performance.now() + FADE_MS });
  if (from) await frames(c, run, FADE_MS, t => place(c, { x: from.x + DRIFT.x * easeInOut(t), y: from.y + DRIFT.y * easeInOut(t) }));
}

function isPlaceOnScreen(e: CursorEvent) {
  if (isMotionReduced()) return false;
  if (e.gesture === "create") return visibleOf(e.into ?? []) !== undefined;
  if (e.gesture === "edit") return visibleOf(e.to) !== undefined || visibleOf(e.into ?? []) !== undefined;
  return visibleOf(e.to) !== undefined;
}

const GESTURES = { drag, edit, create, delete: remove };

const isEditOfNewThing = (e: CursorEvent) => e.gesture === "edit" && !visibleOf(e.to);
const gestureOf = (e: CursorEvent) => (isEditOfNewThing(e) ? create : GESTURES[e.gesture]);

function firstPlaceOf(e: CursorEvent) {
  if (e.gesture === "drag") return [...(e.from ?? []), ...e.to];
  return e.gesture === "create" || isEditOfNewThing(e) ? (e.into ?? []) : e.to;
}

function startAt(c: Cursor, e: CursorEvent) {
  const first = visibleOf(firstPlaceOf(e));
  const goal = first ? tipOf(first.getBoundingClientRect()) : { x: innerWidth / 2, y: innerHeight / 2 };
  place(c, startOf(c, e.agent, goal));
  c.rig?.root.style.setProperty("opacity", "1");
}

async function perform(e: CursorEvent) {
  const release = hold(e.holds, HOLD_CAP_MS);
  if (!isPlaceOnScreen(e)) {
    release();
    return;
  }
  const c = cursors.get(e.agent) ?? { pos: undefined, bend: 1, run: 0, seenUntil: 0 };
  cursors.set(e.agent, c);
  c.run += 1;
  const run = c.run;
  showLabel(e);
  try {
    await waitFor(c, run, RIG_WAIT_MS, () => c.rig);
    startAt(c, e);
    await gestureOf(e)(c, run, e, release);
    release();
    await fadeOut(c, run);
  } catch (error) {
    release();
    if (!(error instanceof Cancelled)) throw error;
  }
}

export function rigCursor(agent: string, root: HTMLElement) {
  const part = (name: string) => root.querySelector<HTMLElement>(`[data-part="${CSS.escape(name)}"]`);
  const [arrow, tip, caret, ghost] = [part("arrow"), part("tip"), part("caret"), part("ghost")];
  const c = cursors.get(agent);
  if (!c || !arrow || !tip || !caret || !ghost) return;
  c.rig = { root, arrow, tip, caret, ghost };
  if (c.pos) place(c, c.pos);
  return () => {
    if (c.rig?.root === root) delete c.rig;
  };
}

export function runCursors() {
  return onCursor(e => {
    void perform(e);
  });
}
