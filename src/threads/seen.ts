import { useSyncExternalStore } from "react";
import type { Thread } from "@/mock";

// How many messages of each thread Isaac has had on screen, kept in this browser, so the inbox can count what's new.
const key = (id: string) => `seen:${id}`;

/** null for a thread this browser never opened. */
export function seenCount(id: string) {
  try {
    const n = localStorage.getItem(key(id));
    return n === null ? null : Number(n);
  } catch {
    return null;
  }
}

export function markSeen(id: string, count: number) {
  try {
    if (count > (seenCount(id) ?? 0)) localStorage.setItem(key(id), String(count));
  } catch {}
}

/** Set back by hand (marked unread from a message, or read): unlike markSeen it can go down. */
export function setSeen(id: string, count: number) {
  try {
    localStorage.setItem(key(id), String(count));
  } catch {}
  changes++;
  dispatchEvent(new Event("seen-change"));
}
let changes = 0;

/** Marked read: every message in the thread and the subthreads under it. */
export function markRead(t: Thread, all: Thread[]) {
  setSeen(t.id, t.messages.length);
  for (const x of all.filter(x => x.parentId === t.id)) markRead(x, all);
}

/** Marked unread: its last message is new again. */
export const markUnread = (t: Thread) => setSeen(t.id, t.messages.length - 1);

/** Draws again when a thread is marked read or unread, since what he has seen lives outside the stores. */
export function useSeen() {
  useSyncExternalStore(onSeenChange, () => changes);
}
const onSeenChange = (draw: () => void) => (addEventListener("seen-change", draw), () => removeEventListener("seen-change", draw));

/** What he hasn't seen in a thread and every subthread under it, so a reply deep down shows on the inbox row. */
export function unseenDeep(t: Thread, all: Thread[]): number {
  return unseen(t) + all.filter(x => x.parentId === t.id).reduce((n, x) => n + unseenDeep(x, all), 0);
}

/** Replies he hasn't had on screen; a thread this browser never opened counts what came after his last message. A top thread's
 * opening message is on its inbox row, so it counts as seen and a thread with no replies has nothing new. */
export function unseen(t: Thread) {
  return Math.max(0, t.messages.length - shownOf(t));
}
const shownOf = (t: Thread) => Math.max(seenCount(t.id) ?? t.messages.findLastIndex(m => m.from === "isaac") + 1, t.parentId ? 0 : 1);

/** Where his unread messages start in the thread's messages, or undefined with none: where the red "New" line goes. */
export function firstUnseen(t: Thread) {
  const shown = shownOf(t);
  return shown < t.messages.length ? shown : undefined;
}

// Which resurfacing this browser has already marked unread, so a reload doesn't mark it again after he read it.
const handled = (id: string) => `resurfaced:${id}`;

/** A thread back from its pause is unread from where he paused it (its last message at least), so it sorts up with the red line. */
export function markResurfaced(threads: Thread[]) {
  for (const t of threads) {
    if (!t.resurfaced) continue;
    try {
      if (localStorage.getItem(handled(t.id)) === t.resurfaced.at) continue;
      localStorage.setItem(handled(t.id), t.resurfaced.at);
    } catch {
      continue;
    }
    setSeen(t.id, Math.max(t.parentId ? 0 : 1, Math.min(t.resurfaced.from, t.messages.length - 1)));
  }
}
