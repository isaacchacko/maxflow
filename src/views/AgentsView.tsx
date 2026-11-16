import { Network, User, Waypoints } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { agentStateColor, statusColor, objectiveStatus, type Agent } from "@/mock";
import { agentStore, taskStore, objectiveStore } from "@/store";

function WorkerCard({ agent }: { agent: Agent }) {
  const tasks = taskStore.use();
  const current = tasks.find(t => agent.taskIds.includes(t.id) && t.status !== "done") ?? tasks.find(t => t.id === agent.taskIds.at(-1));
  return (
    <div className="relative ml-4 pl-4 before:absolute before:top-0 before:left-0 before:h-1/2 before:w-3 before:rounded-bl-md before:border-b before:border-l">
      <Card data-agent={`agent:${agent.id}`} onClick={() => (location.hash = `agent/${agent.id}`)} className="cursor-pointer gap-1 px-3 py-2.5 hover:border-ring">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", agentStateColor[agent.state], agent.state === "working" && "animate-pulse")} />
          <span className="font-mono text-xs">{agent.id}</span>
          <span className="ml-auto text-xs text-muted-foreground">{agent.state}</span>
        </div>
        <p className="text-xs text-muted-foreground">{agent.doing}</p>
        {current && (
          <a href={`#task/${current.id}`} className="mt-1 flex items-center gap-1.5 truncate text-xs hover:underline">
            <span className={cn("size-1.5 shrink-0 rounded-full", statusColor[current.status])} />
            {current.title}
          </a>
        )}
      </Card>
    </div>
  );
}

export function AgentsView() {
  const objectives = objectiveStore.use();
  const tasks = taskStore.use();
  const agents = agentStore.use();

  return (
    <div className="flex h-full flex-col items-center gap-4 overflow-auto p-4">
      <Badge variant="outline" className="gap-1.5 px-3 py-1 text-sm">
        <User className="size-3.5" /> isaac
      </Badge>
      <div className="grid w-full flex-1 grid-cols-4 gap-4">
        {objectives.map(objective => {
          const status = objectiveStatus(objective.taskIds.map(id => tasks.find(t => t.id === id)!.status));
          const routers = agents.filter(a => a.objectiveId === objective.id && a.role === "router");
          return (
            <section key={objective.id} className="flex flex-col gap-3 rounded-xl bg-muted/30 p-3">
              <a href={`#objective/${objective.id}`} data-agent={`objective:${objective.id}`}>
                <Card className="gap-1 px-3 py-3 transition-colors hover:border-ring">
                  <CardHeader className="flex items-center gap-2 px-0">
                    <Waypoints className="size-4 text-agent" />
                    <CardTitle className="truncate text-sm">{objective.title}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex items-center gap-2 px-0 text-xs text-muted-foreground">
                    <span className={cn("size-1.5 rounded-full", statusColor[status])} />
                    {status} · {objective.taskIds.length} tasks
                  </CardContent>
                </Card>
              </a>
              {routers.map(router => (
                <div key={router.id} className="flex flex-col gap-2">
                  <Card data-agent={`agent:${router.id}`} onClick={() => (location.hash = `agent/${router.id}`)} className="cursor-pointer gap-1 border-fuchsia-400/30 px-3 py-2.5 hover:border-fuchsia-400">
                    <div className="flex items-center gap-2">
                      <Network className="size-3.5 text-fuchsia-400" />
                      <span className="font-mono text-xs">{router.id}</span>
                      <Badge variant="outline" className="ml-auto text-[10px]">router</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{router.doing}</p>
                  </Card>
                  {agents.filter(w => w.parent === router.id).map(w => <WorkerCard key={w.id} agent={w} />)}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
