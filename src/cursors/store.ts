import { createStore } from "@/store";
import { elementsFor } from "./geometry";

export type CursorEvent = { agent: string; name: string; action: string; targets: string[]; at: number };
export type Tuning = { speed: number; arc: number; idleSeconds: number; isMotionReduced: boolean };
export type Missed = CursorEvent & { count: number };

const SHOWN_KEY = "cursors-shown";
const KEEP_RECENT = 40;

function savedShown() {
  try {
    return localStorage.getItem(SHOWN_KEY) !== "0";
  } catch {
    return true;
  }
}

export const shownStore = createStore(savedShown());
export const tuningStore = createStore<Tuning>({ speed: 1, arc: 0.18, idleSeconds: 4, isMotionReduced: false });
export const recentStore = createStore<CursorEvent[]>([]);
export const missedStore = createStore<Missed[]>([]);

const listeners = new Set<(e: CursorEvent) => void>();

export function onCursor(listener: (e: CursorEvent) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function fireCursor(e: CursorEvent) {
  recentStore.set(all => [e, ...all].slice(0, KEEP_RECENT));
  if (!e.targets.some(id => elementsFor(id).length > 0)) noteMissed(e);
  for (const listener of listeners) listener(e);
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

const isCursorEvent = (m: Record<string, unknown>) =>
  typeof m["agent"] === "string" && typeof m["name"] === "string" && typeof m["action"] === "string" && Array.isArray(m["targets"]) && typeof m["at"] === "number";

export function cursorFrom(m: Record<string, unknown>): CursorEvent | undefined {
  if (m["type"] !== "cursor" || !isCursorEvent(m)) return undefined;
  return { agent: String(m["agent"]), name: String(m["name"]), action: String(m["action"]), targets: (m["targets"] as unknown[]).map(String), at: Number(m["at"]) };
}
