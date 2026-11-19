import { useCallback, useSyncExternalStore } from "react";

// Held here as well as in localStorage, so typing still works where localStorage throws (a private window, a full quota).
const drafts = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function read(storageKey: string) {
  if (!drafts.has(storageKey)) {
    let saved = "";
    try {
      saved = localStorage.getItem(storageKey) ?? "";
    } catch {}
    drafts.set(storageKey, saved);
  }
  return drafts.get(storageKey)!;
}

function write(storageKey: string, draft: string) {
  drafts.set(storageKey, draft);
  try {
    if (draft) localStorage.setItem(storageKey, draft);
    else localStorage.removeItem(storageKey);
  } catch {}
  listeners.get(storageKey)?.forEach(l => l());
}

/** Typed-but-unsent text, kept in localStorage under `draft:<key>` so a reload or rebuild doesn't lose it; setting "" clears it. */
export function usePersistentDraft(key: string) {
  const storageKey = `draft:${key}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      const mine = listeners.get(storageKey) ?? new Set();
      listeners.set(storageKey, mine.add(listener));
      return () => void mine.delete(listener);
    },
    [storageKey],
  );
  const draft = useSyncExternalStore(subscribe, () => read(storageKey));
  const setDraft = useCallback((next: string | ((prev: string) => string)) => write(storageKey, typeof next === "function" ? next(read(storageKey)) : next), [storageKey]);
  return [draft, setDraft] as const;
}
