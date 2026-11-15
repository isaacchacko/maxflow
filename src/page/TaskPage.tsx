import { ArrowLeft, GitPullRequest } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GRID_COLS, GRID_ROWS, statusColor } from "@/mock";
import { editedStore, taskStore } from "@/store";
import { BlockView } from "./blocks";

export function TaskPage({ id, back }: { id: string; back: string }) {
  const task = taskStore.use().find(t => t.id === id);
  const edited = editedStore.use();
  if (!task) return <p className="p-6 text-muted-foreground">No task {id}.</p>;

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild data-agent="back">
          <a href={`#${back}`}><ArrowLeft /></a>
        </Button>
        <span className={cn("size-2.5 rounded-full", statusColor[task.status])} />
        <h1 className="text-xl font-semibold tracking-tight">{task.title}</h1>
        {task.agent && <Badge variant="secondary">{task.agent}</Badge>}
        {task.pr && (
          <Badge variant="outline" className="gap-1">
            <GitPullRequest className="size-3" />#{task.pr}
          </Badge>
        )}
      </header>
      <div
        data-agent="page"
        className="grid min-h-0 flex-1 grid-flow-row-dense gap-3"
        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))` }}
      >
        {task.page.map(block => (
          <div
            key={`${block.id}-${edited[`${task.id}/${block.id}`] ?? 0}`}
            data-agent={`block:${block.id}`}
            className={cn("min-h-0 rounded-xl", edited[`${task.id}/${block.id}`] && "agent-edited animate-in fade-in zoom-in-95")}
            style={{ gridColumn: `span ${block.w}`, gridRow: `span ${block.h}` }}
          >
            <BlockView block={block} task={task} />
          </div>
        ))}
      </div>
    </div>
  );
}
