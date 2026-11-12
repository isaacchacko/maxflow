import { useState } from "react";
import { ExternalLink, MessageCircleQuestion, SquareKanban, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { ago, type Session, type Task } from "@/lib/api";
import { cn } from "@/lib/utils";

const COLUMNS: { status: Task["status"]; title: string }[] = [
  { status: "todo", title: "To do" },
  { status: "doing", title: "In progress" },
  { status: "you", title: "Needs you" },
  { status: "waiting", title: "Waiting on others" },
  { status: "done", title: "Done" },
];
const DONE_SHOWN = 20;

// The user's task board, which sentry:assistant derives from his prompts and the agents' work; he reads it, never edits it.
export function TasksBoard({ tasks, sessions, onOpen, onClose }: { tasks: Task[]; sessions: Session[]; onOpen: (id: string) => void; onClose: () => void }) {
  const [shown, setShown] = useState<number | null>(null);
  const task = tasks.find((t) => t.id === shown);
  const assistant = sessions.find((s) => s.sentry && s.name === "sentry:assistant");
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background text-xs">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <SquareKanban className="size-4 text-sentry" />
        <span className="font-medium text-foreground">Tasks</span>
        <span className="text-muted-foreground">kept by the assistant from what you ask and what agents do</span>
        {assistant && (
          <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => (onClose(), onOpen(assistant.id))}>talk to it</button>
        )}
        <span className="ml-auto text-muted-foreground"><Kbd>⌘K</Kbd></span>
        <Button variant="ghost" size="icon" className="size-7" title="Close" onClick={onClose}><X /></Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-5 gap-2 overflow-x-auto p-3 max-md:grid-cols-[repeat(5,16rem)]">
        {COLUMNS.map((c) => {
          const column = tasks.filter((t) => t.status === c.status).sort((a, b) => b.updated - a.updated);
          const cards = c.status === "done" ? column.slice(0, DONE_SHOWN) : column;
          return (
            <section key={c.status} className="flex min-h-0 flex-col rounded-lg bg-muted/40">
              <h3 className={cn("flex items-baseline gap-2 px-2.5 pt-2 pb-1.5 font-medium", c.status === "you" && column.length ? "text-sentry" : "text-muted-foreground")}>
                {c.title}
                <span className="font-normal">{column.length}</span>
              </h3>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
                {cards.map((t) => (
                  <button key={t.id} type="button" onClick={() => setShown(t.id)} className="flex flex-col gap-1 rounded-md border bg-card p-2 text-left hover:border-ring">
                    <span className="flex items-start gap-1.5 text-sm text-foreground">
                      {t.kind === "question" && <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                      <span className="line-clamp-3">{t.title}</span>
                    </span>
                    {t.timeline.length > 0 && <span className="line-clamp-2 text-muted-foreground">{t.timeline.at(-1)!.text}</span>}
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span className="font-mono">t{t.id}</span>
                      {t.sessions.length > 0 && <span>{t.sessions.length === 1 ? "1 agent" : `${t.sessions.length} agents`}</span>}
                      <span className="ml-auto">{ago(t.updated)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {!tasks.length && <p className="absolute inset-x-0 top-1/2 text-center text-muted-foreground">No tasks yet. The assistant adds them as you ask agents for things.</p>}
      <Dialog open={!!task} onOpenChange={(o) => !o && setShown(null)}>
        {task && <TaskDetail task={task} sessions={sessions} onOpen={(id) => (setShown(null), onClose(), onOpen(id))} />}
      </Dialog>
    </div>
  );
}

function TaskDetail({ task, sessions, onOpen }: { task: Task; sessions: Session[]; onOpen: (id: string) => void }) {
  const named = new Map(sessions.map((s) => [s.id, s.name]));
  return (
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle className="flex items-start gap-2 pr-6">
          {task.kind === "question" && <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
          {task.title}
        </DialogTitle>
        <DialogDescription className="flex items-center gap-2">
          <Badge variant="outline">{COLUMNS.find((c) => c.status === task.status)?.title ?? task.status}</Badge>
          <span>t{task.id} · started {ago(task.at)} ago · updated {ago(task.updated)} ago</span>
        </DialogDescription>
      </DialogHeader>
      {task.kind === "question" && (
        <section className="rounded-md border p-3 text-sm">
          <h4 className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">Answer</h4>
          <p className={cn("whitespace-pre-wrap", !task.answer && "text-muted-foreground")}>{task.answer ?? "Not answered yet."}</p>
        </section>
      )}
      <ol className="flex flex-col gap-2 border-l pl-4 text-sm">
        {task.timeline.map((e, i) => (
          <li key={i} className="relative">
            <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-border" />
            <span className="mr-2 text-xs text-muted-foreground" title={new Date(e.at).toLocaleString()}>{new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            <span className="whitespace-pre-wrap">{e.text}</span>
            {e.session && (
              <button type="button" className="ml-2 text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => onOpen(e.session!)}>{named.get(e.session) ?? e.session}</button>
            )}
          </li>
        ))}
      </ol>
      {(task.sessions.length > 0 || task.links.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {task.sessions.map((id) => (
            <Button key={id} variant="outline" size="sm" className="h-6" disabled={!named.has(id)} onClick={() => onOpen(id)}>{named.get(id) ?? id}</Button>
          ))}
          {task.links.map((url) => (
            <Button key={url} variant="outline" size="sm" className="h-6" asChild>
              <a href={url} target="_blank" rel="noreferrer"><ExternalLink />{url.replace(/^https?:\/\/(www\.)?/, "")}</a>
            </Button>
          ))}
        </div>
      )}
    </DialogContent>
  );
}
