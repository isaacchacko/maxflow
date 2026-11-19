import { useCallback, useSyncExternalStore } from "react";

// The Stats page's data, one entry per URL, read through useSyncExternalStore so no component syncs a fetch by hand. A URL is
// fetched when the first reader mounts and again when one mounts after it went stale; what was there stays on screen until the
// new answer lands. `again` asks for one more look a few seconds later while the server is still filling something in.

type Loaded<T> = { value?: T; error?: string; loading: boolean };
type Entry = { snap: Loaded<unknown>; at: number; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout>; again?: (v: unknown) => boolean };
const entries = new Map<string, Entry>();
const NOTHING: Loaded<never> = { loading: false };
const STALE_MS = 60_000;
const AGAIN_MS = 4_000;

function load(url: string, e: Entry) {
  e.snap = { ...e.snap, loading: true };
  e.listeners.forEach(l => l());
  fetch(url)
    .then(async r => (r.ok ? r.json() : Promise.reject(new Error((await r.text()) || `HTTP ${r.status}`))))
    .then(
      value => ((e.snap = { value, loading: false }), (e.at = Date.now())),
      (err: Error) => (e.snap = { ...e.snap, error: err.message, loading: false }),
    )
    .finally(() => {
      e.listeners.forEach(l => l());
      clearTimeout(e.timer);
      if (e.snap.value !== undefined && e.again?.(e.snap.value)) e.timer = setTimeout(() => e.listeners.size && load(url, e), AGAIN_MS);
    });
}

export function useJson<T>(url: string | undefined, again?: (value: T) => boolean): Loaded<T> {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!url) return () => {};
      let e = entries.get(url);
      if (!e) entries.set(url, (e = { snap: NOTHING, at: 0, listeners: new Set() }));
      e.again = again as Entry["again"];
      e.listeners.add(listener);
      if (!e.snap.loading && Date.now() - e.at > STALE_MS) load(url, e);
      const mine = e;
      return () => void mine.listeners.delete(listener);
    },
    // `again` is read fresh on each subscribe; the URL alone decides what is fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url],
  );
  return useSyncExternalStore(subscribe, () => ((url && entries.get(url)?.snap) || NOTHING) as Loaded<T>);
}
