import { createStore } from "@/store";
import { isRecord } from "../../shared/guards";
import { elementsFor, type Point } from "./geometry";
import { settleClaims } from "./holds";

export type Gesture = "drag" | "edit" | "create" | "delete";
export type CursorEvent = { agent: string; name: string; gesture: Gesture; action: string; to: string[]; from?: string[] | undefined; into?: string[] | undefined; carry?: string | undefined; onPlane?: Point | undefined; holds: string[]; at: number };
export type Tuning = { speed: number; arc: number; isMotionReduced: boolean };
export type Missed = CursorEvent & { count: number };

const SHOWN_KEY = "cursors-shown";
const KEEP_RECENT = 40;
const RENDER_GRACE_MS = 1500;
const GESTURES = new Set<string>(["drag", "edit", "create", "delete"]);

function isShownSaved() {
  try {
    return localStorage.getItem(SHOWN_KEY) !== "0";
  } catch {
    return true;
  }
}

export const shownStore = createStore(isShownSaved());
export const tuningStore = createStore<Tuning>({ speed: 1, arc: 0.18, isMotionReduced: false });
export const recentStore = createStore<CursorEvent[]>([]);
export const missedStore = createStore<Missed[]>([]);

const listeners = new Set<(e: CursorEvent) => void>();

export function onCursor(listener: (e: CursorEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const placesOf = (e: CursorEvent) => [...e.to, ...(e.from ?? []), ...(e.into ?? [])];

export function fireCursor(e: CursorEvent) {
  recentStore.set(all => [e, ...all].slice(0, KEEP_RECENT));
  setTimeout(() => {
    if (placesOf(e).every(id => elementsFor(id).length === 0)) noteMissed(e);
  }, RENDER_GRACE_MS);
  for (const listener of listeners) listener(e);
  settleClaims(e.holds);
}

export function noteMissed(e: CursorEvent) {
  missedStore.set(all => {
    const same = all.find(x => x.action === e.action);
    if (!same) return [{ ...e, count: 1 }, ...all];
    return [{ ...e, count: same.count + 1 }, ...all.filter(x => x !== same)];
  });
}

export function setShown(isShown: boolean) {
  shownStore.set(isShown);
  try {
    localStorage.setItem(SHOWN_KEY, isShown ? "1" : "0");
  } catch {
    // constraint: localStorage throws in a private window; the choice then lasts until reload
  }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
const pointFrom = (v: unknown) => (isRecord(v) && typeof v["x"] === "number" && typeof v["y"] === "number" ? { x: v["x"], y: v["y"] } : undefined);

export function cursorFrom(m: Record<string, unknown>): CursorEvent | undefined {
  const { agent, name, gesture, action, carry, at } = m;
  const to = strings(m["to"]);
  const isCursor = m["type"] === "cursor" && typeof agent === "string" && typeof name === "string" && typeof action === "string" && typeof at === "number";
  if (!isCursor || typeof gesture !== "string" || !GESTURES.has(gesture) || !to) return undefined;
  return { agent, name, gesture: gesture as Gesture, action, to, from: strings(m["from"]), into: strings(m["into"]), carry: typeof carry === "string" ? carry : undefined, onPlane: pointFrom(m["onPlane"]), holds: strings(m["holds"]) ?? [], at };
}
