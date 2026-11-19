import { useSyncExternalStore } from "react";
import { hasText } from "@/lib/utils";
import type { Thread } from "@/mock";

const seenKey = (id: string) => `seen:${id}`;

export function seenCount(id: string) {
  try {
    const n = localStorage.getItem(seenKey(id));
    return n === null ? null : Number(n);
  } catch {
    return null;
  }
}

function storeSeen(id: string, count: number) {
  try {
    localStorage.setItem(seenKey(id), String(count));
  } catch {
    // constraint: localStorage throws in a private window or on a full quota; the count is then not kept
  }
}

export function markSeen(id: string, count: number) {
  if (count > (seenCount(id) ?? 0)) storeSeen(id, count);
}

const seenChanges = { count: 0 };

export function setSeen(id: string, count: number) {
  storeSeen(id, count);
  seenChanges.count += 1;
  dispatchEvent(new Event("seen-change"));
}

export function markRead(t: Thread, all: Thread[]) {
  setSeen(t.id, t.messages.length);
  const subthreads = all.filter(x => x.parentId === t.id);
  for (const subthread of subthreads) markRead(subthread, all);
}

export const markUnread = (t: Thread) => setSeen(t.id, t.messages.length - 1);

function onSeenChange(draw: () => void) {
  addEventListener("seen-change", draw);
  return () => removeEventListener("seen-change", draw);
}

export function useSeen() {
  useSyncExternalStore(onSeenChange, () => seenChanges.count);
}

export function unseenDeep(t: Thread, all: Thread[]): number {
  return unseen(t) + all.filter(x => x.parentId === t.id).reduce((n, x) => n + unseenDeep(x, all), 0);
}

const rootCountsAsSeen = (t: Thread) => (hasText(t.parentId) ? 0 : 1);
const shownOf = (t: Thread) => Math.max(seenCount(t.id) ?? t.messages.findLastIndex(m => m.from === "isaac") + 1, rootCountsAsSeen(t));

export function unseen(t: Thread) {
  return Math.max(0, t.messages.length - shownOf(t));
}

export function firstUnseen(t: Thread) {
  const shown = shownOf(t);
  return shown < t.messages.length ? shown : undefined;
}

const resurfacingMarkedKey = (id: string) => `resurfaced:${id}`;

export function markResurfaced(threads: Thread[]) {
  for (const t of threads) {
    if (!t.resurfaced) continue;
    try {
      if (localStorage.getItem(resurfacingMarkedKey(t.id)) === t.resurfaced.at) continue;
      localStorage.setItem(resurfacingMarkedKey(t.id), t.resurfaced.at);
    } catch {
      continue;
    }
    setSeen(t.id, Math.max(rootCountsAsSeen(t), Math.min(t.resurfaced.from, t.messages.length - 1)));
  }
}
