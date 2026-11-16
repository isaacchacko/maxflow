import { useEffect, useState } from "react";
import { AgentChat } from "@/agent/AgentChat";
import { AgentCursor } from "@/agent/AgentCursor";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Page } from "@/page/Page";
import type { PageRef } from "@/store";
import { AgentsView } from "@/views/AgentsView";
import { RoutingView } from "@/views/RoutingView";
import { KanbanView } from "@/views/KanbanView";
import { TimelineView } from "@/views/TimelineView";

const views = [
  { id: "routing", label: "Routing", key: "1", View: RoutingView },
  { id: "kanban", label: "Kanban", key: "2", View: KanbanView },
  { id: "timeline", label: "Timeline", key: "3", View: TimelineView },
  { id: "agents", label: "Agents", key: "4", View: AgentsView },
] as const;

type ViewId = (typeof views)[number]["id"];
type Route = { view: ViewId; page?: PageRef };

function lastView(): ViewId {
  try {
    return (sessionStorage.getItem("view") as ViewId | null) ?? "routing";
  } catch {
    return "routing";
  }
}

function routeFromHash(): Route {
  const [first, id] = location.hash.slice(1).split("/");
  if ((first === "task" || first === "objective") && id) return { view: lastView(), page: `${first}/${id}` as PageRef };
  const view = views.find(v => v.id === first)?.id ?? "routing";
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
      if (e.key === "Escape" && routeFromHash().page) location.hash = route.view;
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

  const { View } = views.find(v => v.id === route.view)!;

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-6 border-b px-4 py-2">
          <span className="font-semibold tracking-tight">maxflow</span>
          <Tabs value={route.page ? "" : route.view} onValueChange={v => (location.hash = v)}>
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
          {route.page ? <Page key={route.page} pageRef={route.page} back={route.view} /> : <View />}
        </main>
        <AgentChat />
        <AgentCursor />
      </div>
    </TooltipProvider>
  );
}
