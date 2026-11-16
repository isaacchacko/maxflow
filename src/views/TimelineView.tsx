import { Waypoints } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { NOW, statusColor, type Task } from "@/mock";
import { taskStore, threadStore } from "@/store";

const DAY = 86_400_000;
const FROM = new Date("2026-11-02T00:00:00").getTime();
const TO = new Date("2026-11-18T00:00:00").getTime();
const days = Array.from({ length: (TO - FROM) / DAY }, (_, i) => new Date(FROM + i * DAY));

const pct = (t: number) => `${((t - FROM) / (TO - FROM)) * 100}%`;
const span = (a: number, b: number) => `${((b - a) / (TO - FROM)) * 100}%`;
const fmt = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function range(task: Task) {
  return [new Date(task.start).getTime(), task.end ? new Date(task.end).getTime() : NOW.getTime()] as const;
}

function Bar({ task }: { task: Task }) {
  const [start, end] = range(task);
  const open = !task.end;
  const narrow = (end - start) / (TO - FROM) < 0.07;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={`#task/${task.id}`}
          data-agent={`bar:${task.id}`}
          className="group absolute inset-y-1.5 flex items-center"
          style={{ left: pct(start), width: `max(14px, ${span(start, end)})` }}
        >
          <span
            className={cn(
              "flex size-full items-center gap-2 overflow-hidden rounded-md border px-1.5 text-xs transition-colors group-hover:border-ring",
              open ? "border-border bg-card" : "border-transparent bg-muted/60 text-muted-foreground",
            )}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", statusColor[task.status], task.status === "doing" && "animate-pulse")} />
            {!narrow && <span className="truncate">{task.title}</span>}
          </span>
          {narrow && <span className="absolute left-full ml-2 max-w-44 truncate text-xs">{task.title}</span>}
        </a>
      </TooltipTrigger>
      <TooltipContent>
        {fmt(start)} → {open ? "now" : fmt(end)}
        {task.agent && ` · ${task.agent}`}
      </TooltipContent>
    </Tooltip>
  );
}

export function TimelineView() {
  const tasks = taskStore.use();
  const threads = threadStore.use();
  const byId = new Map(tasks.map(t => [t.id, t]));

  return (
    <div className="flex h-full flex-col overflow-hidden p-4">
      <div className="flex">
        <div className="w-56 shrink-0" />
        <div className="relative h-8 flex-1">
          {days.map(d => (
            <span key={d.getTime()} className="absolute bottom-1 -translate-x-1/2 text-xs text-muted-foreground" style={{ left: pct(d.getTime() + DAY / 2) }}>
              {d.toLocaleDateString("en-US", { weekday: "narrow" })} {d.getDate()}
            </span>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto rounded-xl border bg-muted/20">
        <div className="pointer-events-none absolute inset-y-0 right-0 left-56">
          {days.map(d => (
            <div
              key={d.getTime()}
              className={cn("absolute inset-y-0 border-l border-border/50", [0, 6].includes(d.getDay()) && "bg-muted/30")}
              style={{ left: pct(d.getTime()), width: span(0, DAY) }}
            />
          ))}
          <div className="absolute inset-y-0 w-px bg-agent" style={{ left: pct(NOW.getTime()) }}>
            <span className="absolute top-1 left-1 rounded bg-agent px-1 text-[10px] font-medium text-white">now</span>
          </div>
        </div>

        {threads.map(thread => {
          const items = thread.taskIds.map(id => byId.get(id)!).filter(Boolean);
          const ranges = items.map(range);
          const first = Math.min(...ranges.map(r => r[0]));
          const last = Math.max(...ranges.map(r => r[1]));
          const live = items.some(t => !t.end);
          return (
            <section key={thread.id} data-agent={`lane:${thread.id}`} className="relative border-b last:border-b-0">
              <div className="flex h-10 items-center">
                <a
                  href={`#thread/${thread.id}`}
                  data-agent={`thread:${thread.id}`}
                  className="flex h-full w-56 shrink-0 items-center gap-2 px-3 hover:bg-muted/50"
                >
                  <Waypoints className="size-3.5 shrink-0 text-agent" />
                  <span className="truncate text-sm font-medium">{thread.title}</span>
                  <Badge variant={live ? "secondary" : "outline"} className="shrink-0">{items.length}</Badge>
                </a>
                <div className="relative h-full flex-1">
                  <div
                    className={cn("absolute top-1/2 h-1 -translate-y-1/2 rounded-full", live ? "bg-agent/60" : "bg-muted-foreground/30")}
                    style={{ left: pct(first), width: span(first, last) }}
                  />
                </div>
              </div>
              {items.map(task => (
                <div key={task.id} className="flex h-9">
                  <div className="w-56 shrink-0" />
                  <div className="relative flex-1">
                    <Bar task={task} />
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
