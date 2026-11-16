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

/** Replies he hasn't had on screen; a thread this browser never opened counts what came after his last message. */
export function unseen(t: Thread) {
  const seen = seenCount(t.id);
  return seen === null ? t.messages.length - 1 - t.messages.findLastIndex(m => m.from === "isaac") : Math.max(0, t.messages.length - seen);
}
