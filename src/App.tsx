import { useEffect, useRef, useState } from "react";
import { AgentPage } from "@/agent/AgentPage";
import { Capture } from "@/components/Capture";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { Viewer } from "@/threads/Viewer";
import { PauseDialog, useResurfacing } from "@/threads/Pause";
import { Sidebar } from "@/components/Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Page } from "@/page/Page";
import type { PageRef } from "@/store";
import { closePane, openPane, paneStore, restorePane } from "@/threads/pane";
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

/**
 * The thread a click in the page lands on: a link to one, an inbox or Todo row, a mention or a card on the canvas. A button, a box, or
 * a link to anything else inside a row is that control's, and the thread page's own way up (← and the breadcrumb) climbs as before.
 */
function threadAt(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  if (!el?.closest("[data-region=main]") || el.closest("button, input, textarea, [role=menuitem], [data-agent=back], [data-agent^='thread-up:']")) return;
  const link = el.closest("a");
  if (link) return link.getAttribute("href")?.match(/^#thread\/(.+)$/)?.[1];
  const card = el.closest<HTMLElement>("[data-node^='thread:']")?.dataset.node?.slice(7);
  if (card) return card;
  const row = el.closest<HTMLElement>("[data-vim]")?.dataset.vim;
  return row?.startsWith("th-") ? row : row?.match(/^thread\/(.+)$/)?.[1];
}
// As in Slack, a click on a thread opens it beside the page and ⇧-click opens it as the page (Enter and ⌘K do too). The press of a
// ⇧-click would otherwise select the text between it and the cursor.
const onThreadClick = (e: MouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.button !== 0) return;
  const id = threadAt(e.target);
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey) location.hash = `thread/${id}`;
  else openPane(id);
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
      // Each page brings back its own side pane: opening a thread in full leaves this page's pane behind (the pane's own thread
      // included, as ↗ does), and coming back here opens it again.
      restorePane();
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
    addEventListener("click", onThreadClick, true);
    addEventListener("mousedown", onShiftDown, true);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
      removeEventListener("click", onThreadClick, true);
      removeEventListener("mousedown", onShiftDown, true);
    };
  }, [route.view]);

  const snap = ROUTING.indexOf(route.view);
  const { detail } = route;

  return (
    <TooltipProvider>
      <QuickSwitcher views={views} />
      <Capture />
      <Viewer />
      <PauseDialog />
      {/* Linear's frame: the sidebar sits on the window tint, and each view is one white panel, top to bottom, inset from the edges. */}
      {/* Installed as an app, the tint around the panel drags the window, and the panel starts below the overlaid title bar. */}
      {/* The sidebar runs the window's full height, edge to edge; the panel keeps its margin, below the title bar's strip when
          installed with its window controls overlaid. */}
      <div className="flex h-dvh bg-window [app-region:drag]">
        <Sidebar view={route.view} />
        <main style={{ marginTop: "max(0.5rem, env(titlebar-area-height, 0px))" }} className="mr-2 mb-2 flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-card [app-region:no-drag]">
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
