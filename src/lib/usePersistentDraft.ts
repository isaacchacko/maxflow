import { useEffect, useState } from "react";

/** Typed-but-unsent text, kept in localStorage under `draft:<key>` so a reload or rebuild doesn't lose it; setting "" clears it. */
export function usePersistentDraft(key: string) {
  const storageKey = `draft:${key}`;
  const [draft, setDraft] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    try {
      if (draft) localStorage.setItem(storageKey, draft);
      else localStorage.removeItem(storageKey);
    } catch {}
  }, [storageKey, draft]);

  return [draft, setDraft] as const;
}
