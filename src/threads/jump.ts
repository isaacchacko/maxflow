import { useLayoutEffect, useRef } from "react";
import { threadStore } from "@/store";
import { activeTabId } from "@/tabs";

// Landing on a message: scrolled to and flashed once, whether by climbing out of its subthread or clicking a quote's link to it.
const arriving: { message?: string; compose?: boolean } = {};

// Where he was in each layer (the inbox, its commands column, each thread) of each tab, kept as he scrolls, so coming back lands there.
const SCROLLS = "layer-scroll";
const scrolls: Record<string, number> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(SCROLLS) ?? "{}");
  } catch {
    return {};
  }
})();
// How he reached the page now drawn: up out of a thread (from: that thread; Esc, h, ←, Back, a resolve or pause), or Back/Forward
// (or a reload) to a page he had open, which history.state marks as seen. Either puts each layer back where he left it; anything
// else, such as opening a thread from the inbox, draws it fresh.
let arrival: { restore: boolean; from?: string } = { restore: !!history.state?.seen };
history.replaceState({ ...history.state, seen: true }, "");

/** The route changed: from the thread he was in, if any, to a thread or a view (anything else is neither). */
export function arrive(from: string | undefined, to: { thread?: string; view?: boolean }) {
  const traversal = !!history.state?.seen;
  history.replaceState({ ...history.state, seen: true }, "");
  const t = from ? threadStore.get().find(x => x.id === from) : undefined;
  const up = !!t && (t.parentId ? to.thread === t.parentId : !!to.view);
  arrival = { restore: up || traversal, from: up ? from : undefined };
  // Up into the parent thread, the message the subthread hangs off is flashed and takes the cursor.
  if (up && t.parentId) arriving.message = t.parentMessageId;
}

/** Whether this page's layers are being put back where he left them, so nothing else scrolls them on arrival. */
export const restoring = () => arrival.restore;

/** The thread he just climbed out of into the inbox, once: its row takes the cursor and flashes. */
export function arrivedFrom() {
  const from = arrival.from;
  arrival.from = undefined;
  return from;
}

/**
 * Keeps `layer`'s scroll as he scrolls it, and on arrival back puts it there before the first paint, so nothing jumps.
 * Returns whether it did, so the page skips its own opening scroll.
 */
export function useLayerScroll(layer: string, ref: React.RefObject<HTMLElement | null>) {
  const restored = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const key = `${activeTabId()}:${layer}`;
    restored.current = arrival.restore && scrolls[key] !== undefined;
    if (restored.current) el.scrollTop = scrolls[key]!;
    let frame = 0;
    const onScroll = () =>
      (frame ||= requestAnimationFrame(() => {
        frame = 0;
        scrolls[key] = el.scrollTop;
        try {
          sessionStorage.setItem(SCROLLS, JSON.stringify(scrolls));
        } catch {}
      }));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => (el.removeEventListener("scroll", onScroll), cancelAnimationFrame(frame));
  }, [layer]);
  return restored;
}

/** Brings an element into view and flashes it: centered on a fresh arrival, only as far as needed where his scroll was put back. */
export function flash(el: Element) {
  el.scrollIntoView({ block: arrival.restore ? "nearest" : "center" });
  el.animate([{ backgroundColor: "color-mix(in oklch, var(--color-link) 25%, transparent)" }, { backgroundColor: "transparent" }], { duration: 1600, easing: "ease-out" });
}

/** Flashes the message he landed on and returns its id, so the page can put its cursor there. */
export function flashMessage(id = arriving.message) {
  arriving.message = undefined;
  const el = id && document.querySelector(`[data-msg="${id}"]`);
  if (!el) return;
  flash(el);
  return id;
}

/** The next thread page he opens starts in its message box, as replying from the keyboard (r) expects. */
export const composeOnArrival = () => void (arriving.compose = true);
export function takeCompose() {
  const compose = arriving.compose;
  arriving.compose = undefined;
  return compose;
}

/** Opens a thread at one of its messages; the thread page flashes it once it has drawn. */
export function goToMessage(threadId: string, messageId?: string) {
  if (location.hash === `#thread/${threadId}`) return flashMessage(messageId);
  arriving.message = messageId;
  location.hash = `thread/${threadId}`;
}
