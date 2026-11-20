import { useCallback, useSyncExternalStore } from "react";
import { useLatest } from "@/lib/effects";
import { hasText } from "@/lib/utils";

type Loaded<T> = { value?: T; error?: string; loading: boolean };
type Entry<T> = { snap: Loaded<T>; at: number; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout>; isLookAgainDue?: boolean; shouldLookAgain?: (value: T) => boolean };
const entries = new Map<string, Entry<unknown>>();
const NOTHING: Loaded<never> = { loading: false };
const STALE_MS = 60_000;
const LOOK_AGAIN_MS = 4000;

const entryAt = <T>(url: string | undefined) => (hasText(url) ? (entries.get(url) as Entry<T> | undefined) : undefined);

function notify(entry: Entry<unknown>) {
  for (const listener of entry.listeners) listener();
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(hasText(body) ? body : `HTTP ${response.status}`);
  }
  const value: unknown = await response.json();
  return value;
}

async function load(url: string) {
  const entry = entries.get(url);
  if (!entry) return;
  entry.snap = { ...entry.snap, loading: true };
  entry.isLookAgainDue = false;
  notify(entry);
  try {
    entry.snap = { value: await fetchJson(url), loading: false };
    entry.at = Date.now();
  } catch (error) {
    entry.snap = { ...entry.snap, error: error instanceof Error ? error.message : String(error), loading: false };
  }
  notify(entry);
  clearTimeout(entry.timer);
  if (entry.snap.value !== undefined && entry.shouldLookAgain?.(entry.snap.value) === true) {
    entry.timer = setTimeout(() => {
      if (entry.listeners.size > 0) void load(url);
      else entry.isLookAgainDue = true;
    }, LOOK_AGAIN_MS);
  }
}

export function useJson<T>(url: string | undefined, shouldLookAgain?: (value: T) => boolean): Loaded<T> {
  const latestShouldLookAgain = useLatest(shouldLookAgain);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!hasText(url)) return () => null;
      if (!entries.has(url)) entries.set(url, { snap: NOTHING, at: 0, listeners: new Set() });
      const entry = entryAt<T>(url);
      if (!entry) return () => null;
      entry.shouldLookAgain = value => latestShouldLookAgain.current?.(value) === true;
      entry.listeners.add(listener);
      if (!entry.snap.loading && (entry.isLookAgainDue === true || Date.now() - entry.at > STALE_MS)) void load(url);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [url, latestShouldLookAgain],
  );
  return useSyncExternalStore(subscribe, () => entryAt<T>(url)?.snap ?? NOTHING);
}
