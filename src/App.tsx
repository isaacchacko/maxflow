import { useEffect, useState } from "react";
import { AgentPage } from "@/agent/AgentPage";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Page } from "@/page/Page";
import type { PageRef } from "@/store";
import { ThreadPage } from "@/threads/ThreadPage";
import { InboxView } from "@/views/InboxView";
import { RoutingView } from "@/views/RoutingView";
import { SentriesView } from "@/views/SentriesView";

export const views = [
  { id: "inbox", label: "Inbox", key: "1" },
  { id: "events", label: "Events", key: "2" },
  { id: "objectives", label: "Objectives", key: "3" },
  { id: "agents", label: "Agents", key: "4" },
  { id: "threads", label: "Threads", key: "5" },
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

export function App() {
  const [route, setRoute] = useState(routeFromHash);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape" && routeFromHash().detail) location.hash = route.view;
      const match = views.find(v => v.key === e.key);
      if (match) location.hash = match.id;
    };
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
    };
  }, [route.view]);

  const snap = ROUTING.indexOf(route.view);
  const { detail } = route;

  return (
    <TooltipProvider>
      <QuickSwitcher views={views} />
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-6 border-b px-4 py-2">
          <span className="font-semibold tracking-tight">maxflow</span>
          <Tabs value={detail ? "" : route.view} onValueChange={v => (location.hash = v)}>
            <TabsList>
              {views.map(v => (
                <TabsTrigger key={v.id} value={v.id} data-agent={`tab:${v.id}`} className="gap-2">
                  {v.label}
                  <Kbd>{v.key}</Kbd>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          {detail?.kind === "agent" ? (
            <AgentPage key={detail.id} id={detail.id} back={route.view} />
          ) : detail?.kind === "thread" ? (
            <ThreadPage key={detail.id} id={detail.id} back={route.view} />
          ) : detail?.kind === "page" ? (
            <Page key={detail.ref} pageRef={detail.ref} back={route.view} />
          ) : route.view === "inbox" ? (
            <InboxView />
          ) : route.view === "sentries" ? (
            <SentriesView />
          ) : (
            <RoutingView snap={snap} onSnap={n => (location.hash = ROUTING[Math.max(0, Math.min(ROUTING.length - 1, n))]!)} />
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
