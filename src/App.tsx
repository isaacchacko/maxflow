import { useEffect, useState } from "react";
import { AgentChat } from "@/agent/AgentChat";
import { AgentCursor } from "@/agent/AgentCursor";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskPage } from "@/page/TaskPage";
import { GraphView } from "@/views/GraphView";
import { KanbanView } from "@/views/KanbanView";

const views = [
  { id: "graph", label: "Graph", key: "1", View: GraphView },
  { id: "kanban", label: "Kanban", key: "2", View: KanbanView },
] as const;

type ViewId = (typeof views)[number]["id"];
type Route = { view: ViewId; task?: string };

function lastView(): ViewId {
  try {
    return (sessionStorage.getItem("view") as ViewId | null) ?? "graph";
  } catch {
    return "graph";
  }
}

function routeFromHash(): Route {
  const [first, id] = location.hash.slice(1).split("/");
  if (first === "task" && id) return { view: lastView(), task: id };
  const view = views.find(v => v.id === first)?.id ?? "graph";
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
      if (e.key === "Escape" && routeFromHash().task) location.hash = route.view;
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
          <Tabs value={route.task ? "" : route.view} onValueChange={v => (location.hash = v)}>
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
          {route.task ? <TaskPage id={route.task} back={route.view} /> : <View />}
        </main>
        <AgentChat />
        <AgentCursor />
      </div>
    </TooltipProvider>
  );
}
