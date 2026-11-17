import { Bot, GitPullRequest, Hash, SquareKanban, type LucideIcon } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import type { Task, Thread } from "@/mock";
import { agentStore, taskStore, threadStore } from "@/store";
import { useLayerScroll } from "@/threads/jump";
import { ago } from "@/threads/Replies";
import { Avatar, Rich } from "@/threads/Rich";
import { useVim, vimRow } from "@/threads/vim";

// What is on him: agents waiting on his answer first, then his board's tasks that are on him, being done, or still to do.

const ORDER = ["you", "doing", "todo"] as const;
const HEADING: Record<(typeof ORDER)[number], string> = { you: "On you", doing: "In progress", todo: "To do" };
const DOT: Record<(typeof ORDER)[number], string> = { you: "bg-warn", doing: "bg-link", todo: "bg-muted-foreground/50" };

/** Where a task came from, from its first link: a GitHub PR, a Slack thread, a Linear issue, or an agent's own. */
function sourceOf(t: Task): [string, LucideIcon] {
  const url = t.links?.[0] ?? "";
  if (/github\.com/.test(url)) return [t.pr ? `#${t.pr}` : "GitHub", GitPullRequest];
  if (/slack\.com/.test(url)) return ["Slack", Hash];
  if (/linear\.app/.test(url)) return [url.match(/[A-Z]+-\d+/)?.[0] ?? "Linear", SquareKanban];
  return ["agent", Bot];
}

/** A task opens in the thread it came from, else its agent, else its own page. */
const placeOf = (t: Task, threads: Thread[]) => {
  const thread = threads.find(x => x.taskId === t.id);
  return thread ? `thread/${thread.id}` : t.agent ? `agent/${t.agent}` : `task/${t.id}`;
};

export function TodoView() {
  const threads = threadStore.use();
  const tasks = taskStore.use();
  const agents = agentStore.use();
  const asks = threads.filter(t => t.asks && !t.resolved && !t.paused).sort((a, b) => a.asks!.since.localeCompare(b.asks!.since));
  const groups = ORDER.map(status => ({ status, tasks: tasks.filter(t => t.board === status).sort((a, b) => b.start.localeCompare(a.start)) })).filter(g => g.tasks.length);
  const places = [...asks.map(t => `thread/${t.id}`), ...groups.flatMap(g => g.tasks.map(t => placeOf(t, threads)))];
  const scrollRef = useRef<HTMLDivElement>(null);
  const go = (place: string) => (location.hash = place);
  const vim = useVim("todo", places, scrollRef, "first", { compose: () => {}, open: go });
  useLayerScroll("todo", scrollRef);

  const row = (place: string, body: React.ReactNode) => (
    <li key={place} {...vimRow(place)}>
      <a href={`#${place}`} className={cn("flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted/60", vim.cursor === place && "bg-muted/60 shadow-[inset_2px_0_0_var(--color-link)]")}>
        {body}
      </a>
    </li>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center border-b px-5">
        <h1 className="text-sm font-medium">Todo</h1>
      </header>
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      {vim.panel}
      {asks.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">Needs you · {asks.length}</h2>
          <ol className="flex flex-col">
            {asks.map(t => {
              const said = t.messages.findLast(m => m.from !== "isaac") ?? t.messages[0];
              return row(
                `thread/${t.id}`,
                <>
                  <Avatar from={said?.from ?? t.asks!.sessionId} small />
                  <span className="shrink-0 rounded-full bg-warn-soft px-2 text-xs font-medium text-warn">needs you</span>
                  <Rich still text={(said?.text ?? t.title).split("\n")[0]!} className="min-w-0 flex-1 truncate" />
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(Date.parse(t.asks!.since))}</span>
                </>,
              );
            })}
          </ol>
        </section>
      )}
      {groups.map(({ status, tasks }) => (
        <section key={status} className="mb-5">
          <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">
            {HEADING[status]} · {tasks.length}
          </h2>
          <ol className="flex flex-col">
            {tasks.map(t => {
              const [source, Icon] = sourceOf(t);
              const agent = agents.find(a => a.id === t.agent);
              return row(
                placeOf(t, threads),
                <>
                  <span className={cn("size-2 shrink-0 rounded-full", DOT[status])} />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  {agent && <span className="hidden max-w-60 shrink truncate text-xs text-muted-foreground md:inline">{agent.name}</span>}
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    <Icon className="size-3" />
                    {source}
                  </span>
                  <span className="w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{ago(Date.parse(t.start))}</span>
                </>,
              );
            })}
          </ol>
        </section>
      ))}
      {!asks.length && !groups.length && <p className="px-2.5 text-sm text-muted-foreground">Nothing on you.</p>}
    </div>
    </div>
  );
}
