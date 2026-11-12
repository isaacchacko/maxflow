import { useRef, useState } from "react";
import { Bot, ChevronRight, ExternalLink, GitPullRequest, MessageCircleQuestion, MessageSquare, SquareKanban, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Terminal, type TerminalHandle } from "@/components/terminal";
import { ago, store, type OpenComment, type QueuedPr, type Session, type Task } from "@/lib/api";
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
export function TasksBoard({ tasks, prs, comments, sessions, onOpen, onClose }: { tasks: Task[]; prs: QueuedPr[]; comments: OpenComment[]; sessions: Session[]; onOpen: (id: string) => void; onClose: () => void }) {
  const [shown, setShown] = useState<number | null>(null);
  // The review sentry's queue stages a green PR with no reviewer yet as "needs reviewer": only the user sends it for approval.
  const unreviewed = prs.filter((p) => p.stage === "needs reviewer").sort((a, b) => a.created.localeCompare(b.created));
  const task = tasks.find((t) => t.id === shown);
  const assistant = sessions.find((s) => s.sentry && s.name === "sentry:assistant" && s.running);
  const [chatting, setChatting] = useState(() => store.get("mf.tasksChat") !== "0");
  const toggleChat = () => setChatting((c) => (store.set("mf.tasksChat", c ? "0" : "1"), !c));
  const chat = useRef<TerminalHandle | null>(null);
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background text-xs">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <SquareKanban className="size-4 text-sentry" />
        <span className="font-medium text-foreground">Tasks</span>
        <span className="text-muted-foreground">kept by the assistant from what you ask and what agents do</span>
        {assistant && (
          <Button variant={chatting ? "secondary" : "ghost"} size="sm" className="h-6" title="Ask the assistant about your tasks and asks" onClick={toggleChat}><Bot /> Ask</Button>
        )}
        <span className="ml-auto text-muted-foreground"><Kbd>⌘K</Kbd></span>
        <Button variant="ghost" size="icon" className="size-7" title="Close" onClick={onClose}><X /></Button>
      </div>
      <div className="flex min-h-0 flex-1">
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[repeat(6,minmax(13rem,1fr))] gap-2 overflow-x-auto p-3">
        {COLUMNS.map((c) => {
          const column = tasks.filter((t) => t.status === c.status).sort((a, b) => b.updated - a.updated);
          const cards = c.status === "done" ? column.slice(0, DONE_SHOWN) : column;
          const count = column.length + (c.status === "you" && unreviewed.length ? 1 : 0);
          return (
            <section key={c.status} className="flex min-h-0 flex-col rounded-lg bg-muted/40">
              <h3 className={cn("flex items-baseline gap-2 px-2.5 pt-2 pb-1.5 font-medium", c.status === "you" && count ? "text-sentry" : "text-muted-foreground")}>
                {c.title}
                <span className="font-normal">{count}</span>
              </h3>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
                {c.status === "you" && unreviewed.length > 0 && <UnreviewedPrs prs={unreviewed} />}
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
        <CommentsColumn comments={comments} />
      </div>
      {assistant && chatting && (
        <aside className="flex w-[32rem] max-w-[40%] shrink-0 flex-col border-l">
          <p className="border-b px-3 py-1.5 text-muted-foreground">The assistant's own pane: ask it what's on your plate, or whether an ask was answered.</p>
          <div className="min-h-0 flex-1 py-2 pl-3 pr-1"><Terminal key={assistant.id} id={assistant.id} handle={chat} onClose={() => {}} /></div>
        </aside>
      )}
      </div>
      {!tasks.length && !unreviewed.length && <p className="absolute inset-x-0 top-1/2 text-center text-muted-foreground">No tasks yet. The assistant adds them as you ask agents for things.</p>}
      <Dialog open={!!task} onOpenChange={(o) => !o && setShown(null)}>
        {task && <TaskDetail task={task} sessions={sessions} onOpen={(id) => (setShown(null), onClose(), onOpen(id))} />}
      </Dialog>
    </div>
  );
}

// The user's PR comments still open, newest first; each links to the comment on GitHub.
function CommentsColumn({ comments }: { comments: OpenComment[] }) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg bg-muted/40">
      <h3 className="flex items-baseline gap-2 px-2.5 pt-2 pb-1.5 font-medium text-muted-foreground">
        Your open comments
        <span className="font-normal">{comments.length}</span>
      </h3>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
        {comments.toSorted((a, b) => b.at - a.at).map((c) => (
          <a key={c.id} href={c.url} target="_blank" rel="noreferrer" className="flex flex-col gap-1 rounded-md border bg-card p-2 hover:border-ring">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <MessageSquare className="size-3 shrink-0" />
              <span className="font-mono">{c.pr.replace(/^[^/]+\//, "")}</span>
              <span className="ml-auto">{ago(c.at)}</span>
            </span>
            <span className="line-clamp-4 text-sm whitespace-pre-wrap text-foreground">{c.body}</span>
            <span className="truncate text-muted-foreground" title={c.title}>{c.path ?? c.title}</span>
            {c.replies > 0 && <span className="text-muted-foreground">{c.replies === 1 ? "1 reply, thread still open" : `${c.replies} replies, thread still open`}</span>}
          </a>
        ))}
      </div>
    </section>
  );
}

function UnreviewedPrs({ prs }: { prs: QueuedPr[] }) {
  return (
    <Collapsible className="group rounded-md border bg-card">
      <CollapsibleTrigger className="flex w-full items-start gap-1.5 p-2 text-left text-sm text-foreground hover:text-foreground/80">
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span>{prs.length === 1 ? "1 PR needs" : `${prs.length} PRs need`} you to pick a reviewer</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5 border-t p-1">
        {prs.map((p) => (
          <a key={p.pr} href={p.url} target="_blank" rel="noreferrer" className="flex flex-col gap-0.5 rounded px-1.5 py-1 hover:bg-muted">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <GitPullRequest className="size-3 shrink-0" />
              <span className="font-mono">{p.pr.replace(/^[^/]+\//, "")}</span>
              <span className="ml-auto">{ago(Date.parse(p.created))}</span>
            </span>
            <span className="line-clamp-2 text-foreground">{p.title}</span>
          </a>
        ))}
      </CollapsibleContent>
    </Collapsible>
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
