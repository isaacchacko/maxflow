import { useCallback, useState, useSyncExternalStore } from "react";
import { useLatest } from "@/lib/effects";
import { cn } from "@/lib/utils";

export const GAP = 160;
export const VIEWS = 4;
const DEFAULT_CARD_HEIGHT = 96;
const QUIET_SWIPE_MS = 200;
const SWIPE_PX = 60;

export const paneOfSnapSharingTheAgentsSlot = (snap: number) => Math.min(snap, 2);

export type Stage = { snap: number; col: number; pane: number; y: Map<string, number>; observe: (el: HTMLElement) => void; go: (n: number) => void };

export const isFadedAt = (pane: number, index: number) => index !== pane && index !== pane + 1;

export const captureFadedClick = (pane: number, index: number, go: (n: number) => void) => (e: React.MouseEvent) => {
  if (!isFadedAt(pane, index)) return;
  e.stopPropagation();
  e.preventDefault();
  go(index > pane ? index - 1 : index);
};

export const counted = (shownCount: number, total: number) => (shownCount === total ? String(total) : `${shownCount}/${total}`);

function createCardHeights() {
  const heights = new Map<string, number>();
  const listeners = new Set<() => void>();
  const changes = { version: 0 };
  const observer = new ResizeObserver(entries => {
    let hasChanged = false;
    for (const entry of entries) {
      const id = entry.target instanceof HTMLElement ? entry.target.dataset["place"] : undefined;
      const h = Math.round(entry.contentRect.height);
      if (id === undefined || heights.get(id) === h) continue;
      heights.set(id, h);
      hasChanged = true;
    }
    if (!hasChanged) return;
    changes.version += 1;
    for (const listener of listeners) listener();
  });
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { heightOf: (id: string) => heights.get(id) ?? DEFAULT_CARD_HEIGHT, observe: (el: HTMLElement) => observer.observe(el), subscribe, version: () => changes.version };
}

export function useCardHeights() {
  const [cards] = useState(createCardHeights);
  useSyncExternalStore(cards.subscribe, cards.version);
  return cards;
}

function oneViewPerSwipe(step: (direction: number) => void) {
  const swipe = { pushed: 0, isSpent: false, lastAt: 0 };
  return (e: WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const now = performance.now();
    if (now - swipe.lastAt > QUIET_SWIPE_MS) {
      swipe.pushed = 0;
      swipe.isSpent = false;
    }
    swipe.lastAt = now;
    if (swipe.isSpent) return;
    swipe.pushed += e.deltaX;
    if (Math.abs(swipe.pushed) < SWIPE_PX) return;
    step(Math.sign(swipe.pushed));
    swipe.isSpent = true;
  };
}

export function useViewport(snap: number, go: (n: number) => void, onWidth: (width: number) => void) {
  const latestSnap = useLatest(snap);
  const latestGo = useLatest(go);
  const latestOnWidth = useLatest(onWidth);
  return useCallback(
    (viewport: HTMLDivElement) => {
      const ro = new ResizeObserver(() => latestOnWidth.current(viewport.clientWidth));
      ro.observe(viewport);
      const onWheel = oneViewPerSwipe(direction => latestGo.current(latestSnap.current + direction));
      viewport.addEventListener("wheel", onWheel, { passive: false });
      return () => {
        ro.disconnect();
        viewport.removeEventListener("wheel", onWheel);
      };
    },
    [latestSnap, latestGo, latestOnWidth],
  );
}

function placeLook(isAway: boolean, isFaded: boolean) {
  if (isAway) return "pointer-events-none opacity-0";
  return isFaded && "opacity-35";
}

export function Placed({ id, column, only, stage, children }: { id: string; column: number; only?: "agents" | "threads"; stage: Stage; children: React.ReactNode }) {
  const isAway = (only === "threads" && stage.snap !== 3) || (only === "agents" && stage.snap === 3);
  return (
    <div
      data-place={id}
      ref={el => {
        if (el) stage.observe(el);
      }}
      onClickCapture={captureFadedClick(stage.pane, 1 + column, stage.go)}
      className={cn("absolute top-0 transition-[transform,opacity] duration-500 ease-in-out", placeLook(isAway, isFadedAt(stage.pane, 1 + column)))}
      style={{ width: stage.col, left: column * (stage.col + GAP), transform: `translateY(${stage.y.get(id) ?? 0}px)` }}
    >
      {children}
    </div>
  );
}

export function Column({ index, title, count, total, stage, children }: { index: number; title: string; count: number; total: number; stage: Stage; children: React.ReactNode }) {
  return (
    <section className={cn("relative flex min-h-0 shrink-0 flex-col gap-3 transition-opacity duration-500", isFadedAt(stage.pane, index) && "opacity-35")} style={{ width: stage.col }} onClickCapture={captureFadedClick(stage.pane, index, stage.go)}>
      <h2 className="flex h-7 items-center gap-2 text-sm font-medium">
        {title}
        <span className="text-xs text-muted-foreground">{counted(count, total)}</span>
      </h2>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">{children}</div>
    </section>
  );
}
