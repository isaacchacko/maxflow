import { useEffect, useState } from "react";
import { GraphView } from "./views/GraphView";
import { KanbanView } from "./views/KanbanView";
import { ThreadsView } from "./views/ThreadsView";

const views = [
  { id: "graph", label: "Graph", key: "1", View: GraphView },
  { id: "kanban", label: "Kanban", key: "2", View: KanbanView },
  { id: "threads", label: "Threads", key: "3", View: ThreadsView },
] as const;

type ViewId = (typeof views)[number]["id"];

function viewFromHash(): ViewId {
  const id = location.hash.slice(1);
  return views.find(v => v.id === id)?.id ?? "graph";
}

export function App() {
  const [view, setView] = useState<ViewId>(viewFromHash);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const match = views.find(v => v.key === e.key);
      if (match) location.hash = match.id;
    };
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
    };
  }, []);

  const { View } = views.find(v => v.id === view)!;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-6 border-b border-neutral-800 px-4 py-2">
        <span className="font-semibold tracking-tight">maxflow</span>
        <nav className="flex gap-1">
          {views.map(v => (
            <a
              key={v.id}
              href={`#${v.id}`}
              className={`rounded px-3 py-1 text-sm ${
                v.id === view ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {v.label}
              <kbd className="ml-2 text-xs text-neutral-600">{v.key}</kbd>
            </a>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1">
        <View />
      </main>
    </div>
  );
}
