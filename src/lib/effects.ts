// The one module in src/ that may call useEffect or useLayoutEffect (scripts/lint-effects.ts fails the check anywhere else).
// Each hook here names one way a component reaches outside React, so product code says what it does instead of
// syncing state by hand. Everything else derives in render, acts in its event handler, or uses a ref callback.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

type Events = WindowEventMap & DocumentEventMap;
type ListenOptions = { target?: EventTarget | null; capture?: boolean };

/**
 * Calls `handler` for each `type` event on `target` (window unless given) while mounted. The newest handler runs, so it can
 * read this render's state without resubscribing.
 */
export function useEventListener<K extends keyof Events>(type: K, handler: (e: Events[K]) => void, options?: ListenOptions): void;
export function useEventListener(type: string, handler: (e: Event) => void, options?: ListenOptions): void;
export function useEventListener(type: string, handler: (e: Event) => void, { target = window, capture = false }: ListenOptions = {}) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!target) return;
    const listener = (e: Event) => latest.current(e);
    target.addEventListener(type, listener, capture);
    return () => target.removeEventListener(type, listener, capture);
  }, [type, target, capture]);
}

/** The time, drawn again `next(now)` ms after each draw: a clock whose tick can change (each second, then each minute). */
export function useNow(next: (now: number) => number) {
  const [now, setNow] = useState(Date.now);
  const wait = next(now);
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [now, wait]);
  return now;
}

/** `value` once it has held still for `ms`: what a search or preview asks for while he is still typing. */
export function useSettled<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * For something that slides in and out: `mounted` while open and for `outMs` after it closes, so the way out can play;
 * `shown` turns true two frames after it mounts, so the way in starts from where it rests closed.
 */
export function usePresence(open: boolean, outMs: number) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (!mounted) return;
    if (open) {
      let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => setShown(true))));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const done = setTimeout(() => setMounted(false), outMs);
    return () => clearTimeout(done);
  }, [open, mounted, outMs]);
  return { mounted, shown };
}

type Loaded<T> = { value?: T; error?: Error };
type Resource<T> = { state: Loaded<T>; listeners: Set<() => void>; load: () => Promise<T>; generation: number };
const resources = new Map<string, Resource<unknown>>();
const NOTHING: Loaded<never> = {};

function settle<T>(key: string, r: Resource<T>, state: Loaded<T>) {
  if (resources.get(key) !== r) return;
  r.state = state;
  r.listeners.forEach(l => l());
}

function fetchInto<T>(key: string, r: Resource<T>) {
  const generation = ++r.generation;
  return r.load().then(
    value => void (generation === r.generation && settle(key, r, { value })),
    (error: Error) => void (generation === r.generation && settle(key, r, { ...r.state, error })),
  );
}

/**
 * What `load` resolves to, fetched when the first component reading `key` mounts and dropped a moment after the last one
 * unmounts, so coming back fetches it fresh. With no key nothing is fetched. `set` changes the value in place (an edit
 * shown before the server has it), and `reload` fetches it again, resolving once it is in.
 */
export function useResource<T>(key: string | undefined, load: () => Promise<T>) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {};
      let r = resources.get(key) as Resource<T> | undefined;
      if (!r) resources.set(key, (r = { state: NOTHING, listeners: new Set(), load, generation: 0 })), void fetchInto(key, r);
      const mine = r;
      mine.listeners.add(listener);
      return () => {
        mine.listeners.delete(listener);
        // Later, so a component remounting at once (StrictMode, a keyed reset) keeps it instead of fetching again.
        setTimeout(() => mine.listeners.size === 0 && resources.get(key) === mine && resources.delete(key));
      };
    },
    [key],
  );
  const state = useSyncExternalStore(subscribe, () => (key ? ((resources.get(key)?.state as Loaded<T>) ?? NOTHING) : NOTHING));
  const set = (next: (prev: T | undefined) => T) => {
    const r = key && (resources.get(key) as Resource<T> | undefined);
    if (r) settle(key, r, { value: next(r.state.value) });
  };
  const reload = async () => {
    const r = key && (resources.get(key) as Resource<T> | undefined);
    if (r) await fetchInto(key, r);
  };
  return { ...state, set, reload };
}
