import { useCallback } from "react";
import { useLatest } from "@/lib/effects";
import { hasText } from "@/lib/utils";
import { threadStore } from "@/store";
import { isRecord } from "../../shared/guards";

const arriving: { message?: string | undefined; compose?: boolean | undefined } = {};

const LAYER_SCROLLS = "layer-scroll";
function readLayerScrolls(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(LAYER_SCROLLS) ?? "{}");
    const entries = isRecord(parsed) ? Object.entries(parsed) : [];
    return Object.fromEntries(entries.filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}
const layerScrolls = readLayerScrolls();

function isSeenInHistory() {
  const state: unknown = history.state;
  return isRecord(state) && state["seen"] === true;
}
function markSeenInHistory() {
  const state: unknown = history.state;
  history.replaceState({ ...(isRecord(state) && state), seen: true }, "");
}

const arrival: { restore: boolean; from: string | undefined } = { restore: isSeenInHistory(), from: undefined };
markSeenInHistory();

export function arrive(from: string | undefined, to: { thread?: string | undefined; view?: boolean }) {
  const isTraversal = isSeenInHistory();
  markSeenInHistory();
  const t = hasText(from) ? threadStore.get().find(x => x.id === from) : undefined;
  const isUp = t !== undefined && (hasText(t.parentId) ? to.thread === t.parentId : to.view === true);
  arrival.restore = isUp || isTraversal;
  arrival.from = isUp ? from : undefined;
  if (isUp && hasText(t.parentId)) arriving.message = t.parentMessageId;
}

export const isRestoring = () => arrival.restore;

export function arrivedFrom() {
  const from = arrival.from;
  arrival.from = undefined;
  return from;
}

function saveLayerScrolls() {
  try {
    sessionStorage.setItem(LAYER_SCROLLS, JSON.stringify(layerScrolls));
  } catch {
    // constraint: sessionStorage throws in a private window or on a full quota; the scroll then lasts only this page load
  }
}

export function useLayerScroll<E extends HTMLElement>(layer: string, ref: React.RefObject<E | null>, arrived?: (el: E, isRestored: boolean) => void) {
  const latestArrived = useLatest(arrived);
  return useCallback(
    (el: E) => {
      const key = layer;
      ref.current = el;
      const saved = layerScrolls[key];
      const isRestored = arrival.restore && saved !== undefined;
      if (isRestored) el.scrollTo({ top: saved });
      latestArrived.current?.(el, isRestored);
      let frame = 0;
      const onScroll = () => {
        if (frame !== 0) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          layerScrolls[key] = el.scrollTop;
          saveLayerScrolls();
        });
      };
      el.addEventListener("scroll", onScroll, { passive: true });
      return () => {
        el.removeEventListener("scroll", onScroll);
        cancelAnimationFrame(frame);
        ref.current = null;
      };
    },
    [layer, ref, latestArrived],
  );
}

export function flash(el: Element) {
  el.scrollIntoView({ block: arrival.restore ? "nearest" : "center" });
  el.animate([{ backgroundColor: "color-mix(in oklch, var(--color-link) 25%, transparent)" }, { backgroundColor: "transparent" }], { duration: 1600, easing: "ease-out" });
}

export function flashMessage(id = arriving.message) {
  arriving.message = undefined;
  if (!hasText(id)) return;
  const el = document.querySelector(`[data-msg="${CSS.escape(id)}"]`);
  if (!el) return;
  flash(el);
  return id;
}

export const landOn = (messageId?: string) => {
  arriving.message = messageId;
};

export const composeOnArrival = () => {
  arriving.compose = true;
};
export function takeCompose() {
  const compose = arriving.compose;
  arriving.compose = undefined;
  return compose;
}

export function goToMessage(threadId: string, messageId?: string) {
  if (location.hash === `#thread/${threadId}`) {
    flashMessage(messageId);
    return;
  }
  arriving.message = messageId;
  location.hash = `thread/${threadId}`;
}
