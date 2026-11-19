import { useCallback, useSyncExternalStore } from "react";

const draftsInMemory = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function readStored(storageKey: string) {
  try {
    return localStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

function read(storageKey: string) {
  const held = draftsInMemory.get(storageKey);
  if (held !== undefined) return held;
  const saved = readStored(storageKey);
  draftsInMemory.set(storageKey, saved);
  return saved;
}

function store(storageKey: string, draft: string) {
  try {
    if (draft) localStorage.setItem(storageKey, draft);
    else localStorage.removeItem(storageKey);
  } catch {
    // constraint: localStorage throws in a private window or on a full quota; the draft is still held in memory
  }
}

function write(storageKey: string, draft: string) {
  draftsInMemory.set(storageKey, draft);
  store(storageKey, draft);
  const subscribed = listeners.get(storageKey) ?? [];
  for (const notify of subscribed) notify();
}

export function usePersistentDraft(key: string) {
  const storageKey = `draft:${key}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      const mine = listeners.get(storageKey) ?? new Set();
      listeners.set(storageKey, mine.add(listener));
      return () => {
        mine.delete(listener);
      };
    },
    [storageKey],
  );
  const draft = useSyncExternalStore(subscribe, () => read(storageKey));
  const setDraft = useCallback((next: string | ((prev: string) => string)) => write(storageKey, typeof next === "function" ? next(read(storageKey)) : next), [storageKey]);
  return [draft, setDraft] as const;
}
