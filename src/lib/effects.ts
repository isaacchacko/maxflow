import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

type Events = WindowEventMap & DocumentEventMap;
type ListenOptions = { target?: EventTarget | null; capture?: boolean };

export function useLatest<T>(value: T) {
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  });
  return latest;
}

export function useEventListener<K extends keyof Events>(type: K, handler: (e: Events[K]) => void, options?: ListenOptions): void;
export function useEventListener(type: string, handler: (e: Event) => void, options?: ListenOptions): void;
export function useEventListener(type: string, handler: (e: Event) => void, { target = globalThis, capture = false }: ListenOptions = {}) {
  const latest = useLatest(handler);
  useEffect(() => {
    if (!target) return;
    const listener = (e: Event) => latest.current(e);
    target.addEventListener(type, listener, capture);
    return () => target.removeEventListener(type, listener, capture);
  }, [type, target, capture, latest]);
}

export function useNow(msUntilNextTick: (now: number) => number) {
  const [now, setNow] = useState(Date.now);
  const wait = msUntilNextTick(now);
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [now, wait]);
  return now;
}

export function useInterval(callback: () => unknown, ms: number) {
  const latest = useLatest(callback);
  useEffect(() => {
    const timer = setInterval(() => latest.current(), ms);
    return () => clearInterval(timer);
  }, [ms, latest]);
}

export function useSettled<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function usePresence(isOpen: boolean, outMs: number) {
  const [mounted, setMounted] = useState(isOpen);
  const [shown, setShown] = useState(false);
  if (isOpen && !mounted) setMounted(true);
  if (!isOpen && shown) setShown(false);
  useEffect(() => {
    if (!mounted) return;
    if (isOpen) {
      let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => setShown(true))));
      return () => cancelAnimationFrame(frame);
    }
    const done = setTimeout(() => setMounted(false), outMs);
    return () => clearTimeout(done);
  }, [isOpen, mounted, outMs]);
  return { mounted, shown };
}

type Loaded<T> = { value?: T; error?: Error };
type Resource<T> = { key: string; state: Loaded<T>; listeners: Set<() => void>; load: () => Promise<T>; generation: number };
const resources = new Map<string, Resource<unknown>>();
const NOTHING: Loaded<never> = {};

function resourceAt<T>(key: string | undefined) {
  return key === undefined || key === "" ? undefined : (resources.get(key) as Resource<T> | undefined);
}

function settle<T>(owner: Resource<T>, state: Loaded<T>) {
  const resource = resources.get(owner.key);
  if (resource === undefined || resource !== owner) return;
  resource.state = state;
  for (const notify of resource.listeners) notify();
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

async function fetchInto(owner: Resource<unknown>) {
  const resource = resources.get(owner.key);
  if (resource === undefined || resource !== owner) return;
  resource.generation += 1;
  const generation = resource.generation;
  let value: unknown;
  try {
    value = await resource.load();
  } catch (error) {
    if (generation === resource.generation) settle(resource, { ...resource.state, error: asError(error) });
    return;
  }
  if (generation === resource.generation) settle(resource, { value });
}

export function useResource<T>(key: string | undefined, load: () => Promise<T>) {
  const latestLoad = useLatest(load);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (key === undefined || key === "") return () => null;
      let resource = resources.get(key);
      if (!resource) {
        resource = { key, state: NOTHING, listeners: new Set(), load: latestLoad.current, generation: 0 };
        resources.set(key, resource);
        void fetchInto(resource);
      }
      const mine = resource;
      mine.listeners.add(listener);
      return () => {
        mine.listeners.delete(listener);
        // constraint: StrictMode and keyed resets remount at once, so the drop waits a tick and the remount keeps it instead of fetching again
        setTimeout(() => {
          if (mine.listeners.size === 0 && resources.get(key) === mine) resources.delete(key);
        });
      };
    },
    [key, latestLoad],
  );
  const state = useSyncExternalStore(subscribe, () => resourceAt<T>(key)?.state ?? NOTHING);
  const set = (next: (prev: T | undefined) => T) => {
    const resource = resourceAt<T>(key);
    if (resource) settle(resource, { value: next(resource.state.value) });
  };
  const reload = async () => {
    const resource = resourceAt<T>(key);
    if (resource) await fetchInto(resource);
  };
  return { ...state, set, reload };
}
