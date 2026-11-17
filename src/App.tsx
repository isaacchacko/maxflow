import { useEffect, useRef, useState } from "react";
import { AgentPage } from "@/agent/AgentPage";
import { Capture } from "@/components/Capture";
import { Mark } from "@/components/Mark";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { Viewer } from "@/threads/Viewer";
import { PauseDialog, useResurfacing } from "@/threads/Pause";
import { Sidebar } from "@/components/Sidebar";
import { TabBar } from "@/components/TabBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Page } from "@/page/Page";
import type { PageRef } from "@/store";
import { activeTabId, viewBehind, type RouteChange } from "@/tabs";
import { ThreadPage, threadUp } from "@/threads/ThreadPage";
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

// The view a page climbs back to is the one its tab was on before it.
const lastView = (): ViewId => views.find(x => x.id === viewBehind())?.id ?? "inbox";

function routeFromHash(): Route {
  const [first, id] = location.hash.slice(1).split("/");
  if ((first === "task" || first === "objective") && id) return { view: lastView(), detail: { kind: "page", ref: `${first}/${id}` as PageRef } };
  if ((first === "agent" || first === "thread") && id) return { view: lastView(), detail: { kind: first, id } };
  return { view: views.find(v => v.id === first)?.id ?? lastView() };
}

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [tab, setTab] = useState(activeTabId);
  const current = useRef(route);
  useResurfacing();

  useEffect(() => {
    // Each route change tells the pages how he got there: up out of a thread, by Back/Forward, or fresh. Switching to another tab
    // is none of these: that tab's pages come back as he left them, and nothing there was climbed out of.
    const onRoute = (e: Event) => {
      const prev = current.current;
      const next = (current.current = routeFromHash());
      const from = (e as CustomEvent<RouteChange>).detail.moved !== "switch" && prev.detail?.kind === "thread" ? prev.detail.id : undefined;
      arrive(from, { thread: next.detail?.kind === "thread" ? next.detail.id : undefined, view: !next.detail });
      setRoute(next);
      setTab(activeTabId());
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const { detail } = routeFromHash();
      if (e.key === "Escape" && detail?.kind === "thread") threadUp(detail.id, route.view);
      else if (e.key === "Escape" && detail) location.hash = route.view;
      const match = !e.metaKey && !e.altKey && !e.ctrlKey && views.find(v => v.key === e.key);
      if (match) location.hash = match.id;
    };
    addEventListener("route", onRoute);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("route", onRoute);
      removeEventListener("keydown", onKey);
    };
  }, [route.view]);

  const snap = ROUTING.indexOf(route.view);
  const { detail } = route;

  return (
    <TooltipProvider>
      <QuickSwitcher views={views} />
      <Viewer />
      <PauseDialog />
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-4 border-b px-4 py-2">
          <Mark />
          <TabBar />
          <Capture />
        </header>
        {/* Keyed by tab, so each tab's pages mount as its own and put back its own scroll. */}
        <div className="flex min-h-0 flex-1">
        <Sidebar view={detail ? "" : route.view} />
        <main key={tab} className="min-h-0 min-w-0 flex-1 overflow-hidden">
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
        </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
