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

/** What he hasn't seen in a thread and every subthread under it, so a reply deep down shows on the inbox row. */
export function unseenDeep(t: Thread, all: Thread[]): number {
  return unseen(t) + all.filter(x => x.parentId === t.id).reduce((n, x) => n + unseenDeep(x, all), 0);
}

/** Replies he hasn't had on screen; a thread this browser never opened counts what came after his last message. A top thread's
 * opening message is on its inbox row, so it counts as seen and a thread with no replies has nothing new. */
export function unseen(t: Thread) {
  const shown = Math.max(seenCount(t.id) ?? t.messages.findLastIndex(m => m.from === "isaac") + 1, t.parentId ? 0 : 1);
  return Math.max(0, t.messages.length - shown);
}
