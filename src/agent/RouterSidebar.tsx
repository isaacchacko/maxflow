import { Network, Plus, Waypoints } from "lucide-react";
import { Waiting } from "@/components/Waiting";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { agentStateColor, type Agent, type Objective, type Signal, type Task } from "@/mock";
import { agentStore, objectiveStore, pathOf, signalStore, spawnWorker, taskStore } from "@/store";
import { Rich } from "@/threads/Rich";
import { Row, Section, sourceIcon, stateOrder, when } from "./sidebar-parts";

function RouterProperties({ router, objective }: { router: Agent; objective: Objective | undefined }) {
  return (
    <Section title="Properties">
      <Row label="State">
        <span className={cn("size-2 rounded-full", agentStateColor[router.state])} />
        {router.state}
      </Row>
      {objective && (
        <Row label="Objective">
          <a href={`#objective/${objective.id}`} className="flex min-w-0 items-center gap-1.5 hover:underline">
            <Waypoints className="size-3.5 shrink-0 text-agent" />
            <span className="truncate">{objective.title}</span>
          </a>
        </Row>
      )}
      <Row label="Scope">{router.scope}</Row>
    </Section>
  );
}

function CrewSection({ router, crew, tasks }: { router: Agent; crew: Agent[]; tasks: Task[] }) {
  return (
    <Section title={`Agents · ${crew.length}`}>
      {stateOrder.map(state => {
        const group = crew.filter(a => a.state === state);
        if (group.length === 0) return null;
        return (
          <div key={state} className="flex flex-col">
            <p className="flex items-center gap-1.5 pt-1 pb-0.5 text-[11px] text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", agentStateColor[state])} />
              {state} · {group.length}
            </p>
            {group.map(a => {
              const task = tasks.find(t => a.taskIds.includes(t.id));
              return (
                <a key={a.id} href={`#agent/${a.id}`} className="flex flex-col px-1 py-1 hover:bg-muted">
                  <span className="font-mono text-xs">{a.name ?? a.id}</span>
                  {a.wait && a.wait.kind !== "done" ? <Waiting wait={a.wait} className="truncate text-xs text-muted-foreground" /> : <span className="truncate text-xs text-muted-foreground">{task ? task.title : a.doing}</span>}
                </a>
              );
            })}
          </div>
        );
      })}
      <button onClick={() => spawnWorker(router)} className="flex items-center gap-2 px-1 py-1 text-left text-sm text-muted-foreground hover:bg-muted">
        <Plus className="size-3.5" /> Spawn agent
      </button>
    </Section>
  );
}

function DispatchedSection({ dispatched }: { dispatched: { signal: Signal; to: string[] }[] }) {
  return (
    <Section title={`Dispatched · ${dispatched.length}`}>
      {dispatched.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
      {dispatched.slice(0, 10).map(({ signal, to }) => {
        const Icon = sourceIcon[signal.source];
        return (
          <div key={signal.id} className="flex flex-col gap-0.5 py-0.5 text-sm">
            <div className="flex items-start gap-2">
              <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <Rich text={signal.text} className="min-w-0 flex-1 truncate" />
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{when(signal.at)}</span>
            </div>
            <p className="pl-5.5 font-mono text-[11px] text-muted-foreground">
              {to.length > 0 ? (
                to.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}→{" "}
                    <a href={`#agent/${id}`} className="text-foreground hover:underline">
                      {id}
                    </a>
                  </span>
                ))
              ) : (
                <span>kept</span>
              )}
            </p>
          </div>
        );
      })}
    </Section>
  );
}

function PeersSection({ peers }: { peers: Agent[] }) {
  return (
    <Section title={`Other routers on this objective · ${peers.length}`}>
      {peers.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
      {peers.map(r => (
        <a key={r.id} href={`#agent/${r.id}`} className="flex flex-col px-1 py-1 hover:bg-muted">
          <span className="flex items-center gap-1.5 font-mono text-xs">
            <Network className="size-3 text-router" />
            {r.id}
          </span>
          <span className="truncate text-xs text-muted-foreground">{r.scope}</span>
        </a>
      ))}
    </Section>
  );
}

export function RouterSidebar({ router }: { router: Agent }) {
  const agents = agentStore.use();
  const objectives = objectiveStore.use();
  const signals = signalStore.use();
  const tasks = taskStore.use();

  const crew = agents.filter(a => a.parent === router.id);
  const objective = objectives.find(o => o.id === router.objectiveId);
  const peers = agents.filter(a => a.role === "router" && a.objectiveId === router.objectiveId && a.id !== router.id);
  const crewIds = new Set(crew.map(a => a.id));
  const dispatched = signals.filter(s => pathOf(s, agents).routers.includes(router.id)).map(s => ({ signal: s, to: s.routedTo.filter(id => crewIds.has(id)) }));

  return (
    <>
      <RouterProperties router={router} objective={objective} />
      <Separator />
      <CrewSection router={router} crew={crew} tasks={tasks} />
      <Separator />
      <DispatchedSection dispatched={dispatched} />
      <Separator />
      <PeersSection peers={peers} />
    </>
  );
}
