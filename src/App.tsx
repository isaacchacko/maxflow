import { useRef, useState } from "react";
import { useEventListener } from "@/lib/effects";
import { hasText } from "@/lib/utils";
import { AgentPage } from "@/agent/AgentPage";
import { Capture } from "@/components/Capture";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { Viewer } from "@/threads/Viewer";
import { PauseDialog } from "@/threads/Pause";
import { RaiseDialog } from "@/threads/Raise";
import { Sidebar } from "@/components/Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Page } from "@/page/Page";
import type { PageRef } from "@/store";
import { closePane, openPane, paneStore, restorePane } from "@/threads/pane";
import { ThreadPage, threadUp } from "@/threads/ThreadPage";
import { ThreadPane } from "@/threads/ThreadPane";
import { activeRegion } from "@/threads/region";
import { arrive } from "@/threads/jump";
import { InboxView } from "@/views/InboxView";
import { RoutingView } from "@/views/RoutingView";
import { SentriesView } from "@/views/SentriesView";
import { RestrictionsView } from "@/views/RestrictionsView";
import { TodoView } from "@/views/TodoView";
import { DocsView } from "@/views/DocsView";
import { BrowsersView } from "@/views/BrowsersView";
import { StatsView } from "@/views/StatsView";
import { PrsView } from "@/views/PrsView";
import { TimelinesView } from "@/views/TimelinesView";
import { Cursors } from "@/cursors/Cursors";
import { CursorPlayground } from "@/cursors/Playground";

export const views = [
  { id: "todo", label: "Todo" },
  { id: "inbox", label: "Threads" },
  { id: "prs", label: "PRs" },
  { id: "timelines", label: "Timelines" },
  { id: "docs", label: "Docs" },
  { id: "browsers", label: "Browsers" },
  { id: "events", label: "Events" },
  { id: "objectives", label: "Objectives" },
  { id: "agents", label: "Agents" },
  { id: "threads", label: "Thread map" },
  { id: "sentries", label: "Sentries" },
  { id: "restrictions", label: "Restrictions" },
  { id: "stats", label: "Stats" },
] as const;
const ROUTING_CANVAS_IN_SNAP_ORDER: readonly string[] = ["events", "objectives", "agents", "threads"];

type ViewId = (typeof views)[number]["id"];
type Detail = { kind: "page"; ref: PageRef } | { kind: "agent" | "thread"; id: string };
type Route = { view: ViewId; detail?: Detail; sub?: string; dev?: string };

function lastView(): ViewId {
  try {
    const v = sessionStorage.getItem("view");
    return views.find(x => x.id === v)?.id ?? "inbox";
  } catch {
    return "inbox";
  }
}

function hashParts() {
  const [first = "", ...rest] = location.hash.slice(1).split("/");
  return [first, decodeURI(rest.join("/"))] as const;
}

function detailFromHash(first: string, id: string): Route | undefined {
  if (first === "dev") return { view: lastView(), dev: id };
  if (!hasText(id)) return;
  if (first === "task" || first === "objective") return { view: lastView(), detail: { kind: "page", ref: `${first}/${id}` as PageRef } };
  return first === "agent" || first === "thread" ? { view: lastView(), detail: { kind: first, id } } : undefined;
}

function routeFromHash(): Route {
  const [first, id] = hashParts();
  const detail = detailFromHash(first, id);
  if (detail) return detail;
  const view = views.find(v => v.id === first)?.id ?? lastView();
  try {
    sessionStorage.setItem("view", view);
  } catch {
    // constraint: sessionStorage throws in a private window; the view is then not remembered across reloads
  }
  return { view, ...(view === first && hasText(id) && { sub: id }) };
}

const CONTROLS_THAT_KEEP_THEIR_CLICK = "button, input, textarea, [role=menuitem], [data-agent=back], [data-agent^='thread-up:'], [data-agent^='agent-link:']";

function threadLinkedFrom(el: Element) {
  const link = el.closest("a");
  if (link) return /^#thread\/(.+)$/.exec(link.getAttribute("href") ?? "")?.[1];
  const card = el.closest<HTMLElement>("[data-node^='thread:']")?.dataset["node"]?.slice(7);
  if (hasText(card)) return card;
  const row = el.closest<HTMLElement>("[data-row]")?.dataset["row"];
  if (row?.startsWith("th-") === true) return row;
  return /^thread\/(.+)$/.exec(row ?? "")?.[1];
}

function threadAt(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  if (!el?.closest("[data-region=main]") || el.closest(CONTROLS_THAT_KEEP_THEIR_CLICK)) return;
  return threadLinkedFrom(el);
}

const openThreadBesideOrShiftAsPage = (e: MouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.button !== 0) return;
  const id = threadAt(e.target);
  if (!hasText(id)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey) location.hash = `thread/${id}`;
  else openPane(id);
};
const keepShiftClickFromSelectingText = (e: MouseEvent) => {
  if (e.shiftKey && e.button === 0 && hasText(threadAt(e.target))) e.preventDefault();
};

const routingViewAt = (n: number) => ROUTING_CANVAS_IN_SNAP_ORDER[Math.max(0, Math.min(ROUTING_CANVAS_IN_SNAP_ORDER.length - 1, n))] ?? "events";

function DetailView({ detail, back }: { detail: Detail; back: ViewId }) {
  if (detail.kind === "page") return <Page key={detail.ref} pageRef={detail.ref} back={back} />;
  if (detail.kind === "agent") return <AgentPage key={detail.id} id={detail.id} back={back} />;
  return <ThreadPage key={detail.id} id={detail.id} back={back} />;
}

function PathView({ view, sub }: { view: "timelines" | "docs" | "browsers"; sub: string | undefined }) {
  if (view === "timelines") return <TimelinesView path={sub} />;
  if (view === "docs") return <DocsView path={sub} />;
  return <BrowsersView id={sub} />;
}

function MainView({ route }: { route: Route }) {
  if (route.dev === "cursors") return <CursorPlayground />;
  if (route.detail) return <DetailView detail={route.detail} back={route.view} />;
  if (route.view === "inbox") return <InboxView />;
  if (route.view === "todo") return <TodoView />;
  if (route.view === "prs") return <PrsView />;
  if (route.view === "timelines" || route.view === "docs" || route.view === "browsers") return <PathView view={route.view} sub={route.sub} />;
  if (route.view === "restrictions") return <RestrictionsView />;
  if (route.view === "stats") return route.sub === undefined ? <StatsView /> : <StatsView tab={route.sub} />;
  if (route.view === "sentries") return <SentriesView />;
  const snap = ROUTING_CANVAS_IN_SNAP_ORDER.indexOf(route.view);
  return (
    <RoutingView
      snap={snap}
      onSnap={n => {
        location.hash = routingViewAt(n);
      }}
    />
  );
}

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const current = useRef(route);

  useEventListener("hashchange", () => {
    const prev = current.current;
    const next = (current.current = routeFromHash());
    arrive(prev.detail?.kind === "thread" ? prev.detail.id : undefined, { thread: next.detail?.kind === "thread" ? next.detail.id : undefined, view: !next.detail });
    restorePane();
    setRoute(next);
  });
  useEventListener("keydown", e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "Escape" && hasText(paneStore.get()) && activeRegion() === "pane") {
      closePane();
      return;
    }
    const { detail } = routeFromHash();
    if (e.key === "Escape" && detail?.kind === "thread") threadUp(detail.id, route.view);
    else if (detail && e.key === "Escape") location.hash = route.view;
  });
  useEventListener("click", openThreadBesideOrShiftAsPage, { capture: true });
  useEventListener("mousedown", keepShiftClickFromSelectingText, { capture: true });

  return (
    <TooltipProvider>
      <QuickSwitcher views={views} />
      <Capture />
      <Viewer />
      <PauseDialog />
      <RaiseDialog />
      <Cursors />
      <div className="flex h-dvh bg-window [app-region:drag]">
        <Sidebar view={route.view} />
        <main style={{ marginTop: "max(0.5rem, env(titlebar-area-height, 0px))" }} className="mr-2 mb-2 flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-card [app-region:no-drag]">
        <div data-region="main" className="min-h-0 min-w-0 flex-1">
          <MainView route={route} />
        </div>
        <ThreadPane />
        </main>
      </div>
    </TooltipProvider>
  );
}
