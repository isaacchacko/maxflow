import { MessagesSquare, Network, Plus, SquareArrowOutUpRight, Waypoints } from "lucide-react";
import { AgentFace, expressionOf } from "@/components/AgentFace";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Waiting } from "@/components/Waiting";
import { cn, hasText } from "@/lib/utils";
import { objectiveStatus, statusColor, type Agent, type Objective, type Task, type Thread } from "@/mock";
import { Rich } from "@/threads/Rich";

const goTo = (hash: string) => {
  location.hash = hash;
};

export function ThreadCard({ t }: { t: Thread }) {
  const last = t.messages.at(-1);
  return (
    <Card data-node={`thread:${t.id}`} onClick={() => goTo(`thread/${t.id}`)} className="cursor-pointer gap-1.5 px-3 py-2.5 hover:border-ring">
      <div className="flex items-center gap-2">
        <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{t.title}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t.messages.length}</span>
      </div>
      {last && <Rich text={last.text} className="line-clamp-2 text-xs text-muted-foreground" />}
      {t.routerIds.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {t.routerIds.map(r => (
            <span key={r} className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
              <Network className="size-2.5 text-router" />
              {r}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

export type Splitting = { objectiveId: string | undefined; scope: string; onStart: (objectiveId: string) => void; onScope: (scope: string) => void; onSplit: (e: React.SyntheticEvent, objectiveId: string) => void; onCancel: () => void };

function SplitRouter({ o, splitting }: { o: Objective; splitting: Splitting }) {
  if (splitting.objectiveId === o.id) {
    return (
      <form onSubmit={e => splitting.onSplit(e, o.id)} onClick={e => e.stopPropagation()}>
        <Input autoFocus value={splitting.scope} onChange={e => splitting.onScope(e.target.value)} onKeyDown={e => e.key === "Escape" && splitting.onCancel()} placeholder="Scope" className="h-7 text-xs" />
      </form>
    );
  }
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        splitting.onStart(o.id);
      }}
      className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
    >
      <Plus className="size-3" /> Split router
    </button>
  );
}

export function ObjectiveCard({ o, tasks, routerCount, splitting }: { o: Objective; tasks: Task[]; routerCount: number; splitting: Splitting }) {
  const own = tasks.filter(t => o.taskIds.includes(t.id));
  const status = objectiveStatus(own.map(t => t.status));
  return (
    <Card data-node={`obj:${o.id}`} data-agent={`objective:${o.id}`} onClick={() => goTo(`objective/${o.id}`)} className="cursor-pointer gap-2 px-4 py-3 hover:border-ring">
      <div className="flex items-center gap-2">
        <Waypoints className="size-4 shrink-0 text-agent" />
        <span className="truncate font-medium">{o.title}</span>
        <SquareArrowOutUpRight className="ml-auto size-3.5 text-muted-foreground" />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", statusColor[status])} />
        {status} · {own.filter(t => t.status === "done").length}/{own.length} tasks
        <Badge variant="outline" className="ml-auto text-[10px]">
          {routerCount} {routerCount === 1 ? "router" : "routers"}
        </Badge>
      </div>
      <SplitRouter o={o} splitting={splitting} />
    </Card>
  );
}

export function RouterCard({ r, crew, isFresh }: { r: Agent; crew: number; isFresh: boolean }) {
  return (
    <Card data-node={`router:${r.id}`} onClick={() => goTo(`agent/${r.id}`)} className={cn("cursor-pointer gap-1 border-router/30 px-3 py-2.5 hover:border-router", isFresh && "agent-edited animate-in fade-in zoom-in-95")}>
      <div className="flex items-center gap-2">
        <AgentFace id={r.id} expression={expressionOf(r.state)} small still className="size-6" />
        <Network className="size-3 text-router" />
        <span className={cn("truncate text-xs", !hasText(r.name) && "font-mono")}>{r.name ?? r.id}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {crew} {crew === 1 ? "agent" : "agents"}
        </span>
      </div>
      <p className="text-sm">{r.scope}</p>
      <Waiting wait={r.wait} className="text-xs text-muted-foreground" />
    </Card>
  );
}

export function AgentCard({ w, tasks }: { w: Agent; tasks: Task[] }) {
  const task = tasks.find(t => w.taskIds.includes(t.id) && t.status !== "done") ?? tasks.find(t => t.id === w.taskIds.at(-1));
  return (
    <Card data-node={`agent:${w.id}`} onClick={() => goTo(`agent/${w.id}`)} className="cursor-pointer gap-1 px-3 py-2.5 hover:border-ring">
      <div className="flex items-center gap-2">
        <AgentFace id={w.id} expression={expressionOf(w.state)} small still className="size-6" />
        <span className={cn("truncate text-xs", !hasText(w.name) && "font-mono")}>{w.name ?? w.id}</span>
        <span className="ml-auto text-xs text-muted-foreground">{w.state}</span>
      </div>
      <Waiting wait={w.wait} className="text-xs text-muted-foreground" />
      {task && (
        <a href={`#task/${task.id}`} onClick={e => e.stopPropagation()} className="flex items-center gap-1.5 truncate text-xs hover:underline">
          <span className={cn("size-1.5 shrink-0 rounded-full", statusColor[task.status])} />
          {task.title}
        </a>
      )}
    </Card>
  );
}

export const NoAgentsCard = () => <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground transition-opacity">No agents</p>;

export const NoThreadsCard = () => <p className="border border-dashed px-3 py-2 text-xs text-muted-foreground">No threads</p>;
