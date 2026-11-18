import { useEffect, useRef, useState } from "react";
import { AgentPage } from "@/agent/AgentPage";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { Viewer } from "@/threads/Viewer";
import { PauseDialog, useResurfacing } from "@/threads/Pause";
import { Sidebar } from "@/components/Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Page } from "@/page/Page";
import type { PageRef } from "@/store";
import { closePane, openPane, paneStore } from "@/threads/pane";
import { ThreadPage, threadUp } from "@/threads/ThreadPage";
import { ThreadPane } from "@/threads/ThreadPane";
import { activeRegion } from "@/threads/vim";
import { arrive } from "@/threads/jump";
import { InboxView } from "@/views/InboxView";
import { RoutingView } from "@/views/RoutingView";
import { SentriesView } from "@/views/SentriesView";
import { TodoView } from "@/views/TodoView";

export const views = [
  { id: "todo", label: "Todo", key: "0" },
  { id: "inbox", label: "Threads", key: "1" },
  { id: "events", label: "Events", key: "2" },
  { id: "objectives", label: "Objectives", key: "3" },
  { id: "agents", label: "Agents", key: "4" },
  { id: "threads", label: "Thread map", key: "5" },
  { id: "sentries", label: "Sentries", key: "6" },
] as const;
/** Views of one routing canvas, in snap order; the rest are pages of their own. */
const ROUTING: readonly string[] = ["events", "objectives", "agents", "threads"];

type ViewId = (typeof views)[number]["id"];
type Detail = { kind: "page"; ref: PageRef } | { kind: "agent" | "thread"; id: string };
type Route = { view: ViewId; detail?: Detail };

function lastView(): ViewId {
  try {
    const v = sessionStorage.getItem("view");
    return views.find(x => x.id === v)?.id ?? "inbox";
  } catch {
    return "inbox";
  }
}

function routeFromHash(): Route {
  const [first, id] = location.hash.slice(1).split("/");
  if ((first === "task" || first === "objective") && id) return { view: lastView(), detail: { kind: "page", ref: `${first}/${id}` as PageRef } };
  if ((first === "agent" || first === "thread") && id) return { view: lastView(), detail: { kind: first, id } };
  const view = views.find(v => v.id === first)?.id ?? lastView();
  try {
    sessionStorage.setItem("view", view);
  } catch {}
  return { view };
}

/** The thread a shift-click lands on: a link to one, an inbox row, a Todo row, a mention or a card on the canvas. */
function threadAt(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  const href = el?.closest("a")?.getAttribute("href")?.match(/^#thread\/(.+)$/)?.[1];
  if (href) return href;
  const card = el?.closest<HTMLElement>("[data-node^='thread:']")?.dataset.node?.slice(7);
  if (card) return card;
  const row = el?.closest<HTMLElement>("[data-region=main] [data-vim]")?.dataset.vim;
  return row?.startsWith("th-") ? row : row?.match(/^thread\/(.+)$/)?.[1];
}
// Shift-click opens a thread in the side pane, as in Slack; the press would otherwise select text between it and the cursor.
const onShiftClick = (e: MouseEvent) => {
  if (!e.shiftKey || e.metaKey || e.ctrlKey || e.button !== 0) return;
  const id = threadAt(e.target);
  if (id) (e.preventDefault(), e.stopPropagation(), openPane(id));
};
const onShiftDown = (e: MouseEvent) => e.shiftKey && e.button === 0 && threadAt(e.target) && e.preventDefault();

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const current = useRef(route);
  useResurfacing();

  useEffect(() => {
    // Each route change tells the pages how he got there: up out of a thread, by Back/Forward, or fresh.
    const onHash = () => {
      const prev = current.current;
      const next = (current.current = routeFromHash());
      arrive(prev.detail?.kind === "thread" ? prev.detail.id : undefined, { thread: next.detail?.kind === "thread" ? next.detail.id : undefined, view: !next.detail });
      // Opening a thread in full, by any means, cancels the side pane, the pane's own thread included (as its ↗ does).
      if (next.detail?.kind === "thread") closePane();
      setRoute(next);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // In the side pane, Escape closes it and the page underneath stays as it was.
      if (e.key === "Escape" && paneStore.get() && activeRegion() === "pane") return closePane();
      const { detail } = routeFromHash();
      if (e.key === "Escape" && detail?.kind === "thread") threadUp(detail.id, route.view);
      else if (e.key === "Escape" && detail) location.hash = route.view;
      const match = !e.metaKey && !e.altKey && !e.ctrlKey && views.find(v => v.key === e.key);
      if (match) location.hash = match.id;
    };
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    addEventListener("click", onShiftClick, true);
    addEventListener("mousedown", onShiftDown, true);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
      removeEventListener("click", onShiftClick, true);
      removeEventListener("mousedown", onShiftDown, true);
    };
  }, [route.view]);

  const snap = ROUTING.indexOf(route.view);
  const { detail } = route;

  return (
    <TooltipProvider>
      <QuickSwitcher views={views} />
      <Viewer />
      <PauseDialog />
      {/* Linear's frame: the sidebar sits on the window tint, and each view is one white panel, top to bottom, inset from the edges. */}
      {/* Installed as an app, the tint around the panel drags the window, and the panel starts below the overlaid title bar. */}
      <div className="flex h-full bg-window p-2 pl-0 [app-region:drag]">
        <Sidebar view={route.view} />
        <main style={{ marginTop: "max(0px, calc(env(titlebar-area-height, 0px) - 0.5rem))" }} className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-card [app-region:no-drag]">
        <div data-region="main" className="min-h-0 min-w-0 flex-1">
          {detail?.kind === "agent" ? (
            <AgentPage key={detail.id} id={detail.id} back={route.view} />
          ) : detail?.kind === "thread" ? (
            <ThreadPage key={detail.id} id={detail.id} back={route.view} />
          ) : detail?.kind === "page" ? (
            <Page key={detail.ref} pageRef={detail.ref} back={route.view} />
          ) : route.view === "inbox" ? (
            <InboxView />
          ) : route.view === "todo" ? (
            <TodoView />
          ) : route.view === "sentries" ? (
            <SentriesView />
          ) : (
            <RoutingView snap={snap} onSnap={n => (location.hash = ROUTING[Math.max(0, Math.min(ROUTING.length - 1, n))]!)} />
          )}
        </div>
        <ThreadPane />
        </main>
      </div>
    </TooltipProvider>
  );
}
