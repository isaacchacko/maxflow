import { ArrowLeft, GitPullRequest, Waypoints } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GRID_COLS, GRID_ROWS, statusColor, threadStatus, type Block } from "@/mock";
import { editedStore, taskStore, threadStore, type PageRef } from "@/store";
import { BlockView, type Subject } from "./blocks";

function useSubject(ref: PageRef) {
  const [type, id] = ref.split("/");
  const tasks = taskStore.use();
  const threads = threadStore.use();
  if (type === "task") {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    const thread = threads.find(th => th.taskIds.includes(task.id));
    const subject: Subject = { ref, status: task.status, events: task.events, pr: task.pr, threadId: thread?.id };
    return { subject, title: task.title, page: task.page, agent: task.agent, thread };
  }
  const thread = threads.find(th => th.id === id);
  if (!thread) return;
  const status = threadStatus(thread.taskIds.map(tid => tasks.find(t => t.id === tid)!.status));
  const subject: Subject = { ref, status, events: thread.events, threadId: thread.id };
  return { subject, title: thread.title, page: thread.page, agent: undefined, thread: undefined };
}

export function Page({ pageRef, back }: { pageRef: PageRef; back: string }) {
  const found = useSubject(pageRef);
  const edited = editedStore.use();
  if (!found) return <p className="p-6 text-muted-foreground">Nothing at {pageRef}.</p>;
  const { subject, title, page, agent, thread } = found;
  const isThread = pageRef.startsWith("thread/");

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild data-agent="back">
          <a href={`#${back}`}><ArrowLeft /></a>
        </Button>
        {isThread ? <Waypoints className="size-5 text-agent" /> : <span className={cn("size-2.5 rounded-full", statusColor[subject.status])} />}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {isThread && <Badge variant="outline" className="capitalize">{subject.status}</Badge>}
        {agent && <Badge variant="secondary">{agent}</Badge>}
        {subject.pr && (
          <Badge variant="outline" className="gap-1">
            <GitPullRequest className="size-3" />#{subject.pr}
          </Badge>
        )}
        {thread && (
          <a href={`#thread/${thread.id}`} data-agent={`thread:${thread.id}`} className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <Waypoints className="size-4" />
            {thread.title}
          </a>
        )}
      </header>
      <div
        data-agent="page"
        className="grid min-h-0 flex-1 grid-flow-row-dense gap-3"
        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))` }}
      >
        {page.map((block: Block) => {
          const stamp = edited[`${pageRef}/${block.id}`];
          return (
            <div
              key={`${block.id}-${stamp ?? 0}`}
              data-agent={`block:${block.id}`}
              className={cn("min-h-0 rounded-xl", stamp && "agent-edited animate-in fade-in zoom-in-95")}
              style={{ gridColumn: `span ${block.w}`, gridRow: `span ${block.h}` }}
            >
              <BlockView block={block} subject={subject} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
