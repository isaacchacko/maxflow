import { Archive, ArrowLeft, Pause, Play } from "lucide-react";
import { FitLabel, FitRow } from "@/components/Fit";
import { AgentFace, expressionOf } from "@/components/AgentFace";
import { Waiting, WakesWhen } from "@/components/Waiting";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, hasText } from "@/lib/utils";
import { agentStateColor, type Agent } from "@/mock";
import { BrowserPane } from "./BrowserPane";
import { agentStore, api, liveStore, objectiveStore, pathOf, sentryStore, setArchived, shellStore, signalStore, taskStore } from "@/store";
import { RouterSidebar } from "./RouterSidebar";
import { SentryPage } from "./SentryPage";
import { ShellPage } from "./ShellPage";
import { stateOrder } from "./sidebar-parts";
import { when } from "@/threads/MessageRow";
import { Terminal } from "./Terminal";
import { closing, transcriptFor, typedStore } from "./transcript";
import { Tty } from "./Tty";
import { WorkerSidebar } from "./WorkerSidebar";

function interruptTurn(agent: Agent, isLive: boolean) {
  if (isLive) {
    void api(`/api/sessions/${agent.id}/input`, { keys: ["Escape"] });
    return;
  }
  agentStore.set(all => all.map(a => (a.id === agent.id ? { ...a, state: "idle" } : a)));
}

function CrewCounts({ crew }: { crew: Agent[] }) {
  return (
    <span className="hidden shrink-0 items-center gap-3 text-xs whitespace-nowrap text-muted-foreground xl:flex">
      {stateOrder.map(state => {
        const n = crew.filter(a => a.state === state).length;
        return n > 0 ? (
          <span key={state} className="flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", agentStateColor[state])} />
            {n} {state}
          </span>
        ) : null;
      })}
    </span>
  );
}

const sleepLine = "hidden max-w-[32rem] min-w-0 shrink-[2] truncate text-sm whitespace-nowrap text-muted-foreground lg:block";
function SleepOrWait({ agent }: { agent: Agent }) {
  if (hasText(agent.handedTo))
    return (
      <span data-agent="agent-handed-to" title="Its context was filling up, so maxflow moved its role, threads, task, watches and wait to a fresh agent, and messages sent to it go there" className={sleepLine}>
        Handed off to{" "}
        <a href={`#agent/${agent.handedTo}`} className="font-mono hover:underline">
          {agent.handedTo}
        </a>
      </span>
    );
  if (agent.sleep)
    return (
      <span data-agent="agent-asleep" title={`Claude is stopped to free memory. It wakes when ${agent.sleep.wakes}, or when any message reaches it.`} className={sleepLine}>
        Asleep since {when(agent.sleep.at)} to free memory. <WakesWhen wait={agent.wait} />
      </span>
    );
  if (agent.sleepHeld)
    return (
      <span data-agent="agent-held-awake" title="It declared a wait, but sleeping would stop claude and everything running inside it" className={sleepLine}>
        Kept awake: {agent.sleepHeld.what.join(" and ")} still running. It sleeps once they finish.
      </span>
    );
  return (
    <>
      {hasText(agent.handedFrom) && (
        <span data-agent="agent-handed-from" title="It took this work over, with a hand-off note, from an agent whose context was filling up" className={sleepLine}>
          Took over from{" "}
          <a href={`#agent/${agent.handedFrom}`} className="font-mono hover:underline">
            {agent.handedFrom}
          </a>
        </span>
      )}
      <Waiting wait={agent.wait} className="hidden max-w-72 min-w-0 shrink-[2] truncate text-sm whitespace-nowrap text-muted-foreground lg:block" />
    </>
  );
}

function AgentHeader({ agent, crew, back, isLive }: { agent: Agent; crew: Agent[]; back: string; isLive: boolean }) {
  return (
    <FitRow className="h-12 shrink-0 items-center gap-3 border-b px-3 data-[fit=glyph]:gap-1.5">
      <Button variant="ghost" size="icon" asChild data-agent="back" className="shrink-0">
        <a href={`#${back}`}>
          <ArrowLeft />
        </a>
      </Button>
      <AgentFace id={agent.id} expression={expressionOf(agent.state)} className="size-9 shrink-0" />
      <h1 title={agent.name ?? agent.id} data-agent={`agent-name:${agent.id}`} className={cn("min-w-24 truncate group-data-[fit=glyph]/fit:min-w-12 text-lg", !hasText(agent.name) && "font-mono")}>
        {agent.name ?? agent.id}
      </h1>
      <Badge variant="outline" className="shrink-0">
        {agent.role}
      </Badge>
      {agent.role === "router" && (
        <span title={agent.scope} className="hidden max-w-48 min-w-0 shrink-[2] truncate text-sm whitespace-nowrap text-muted-foreground md:block">
          {agent.scope}
        </span>
      )}
      <SleepOrWait agent={agent} />
      {agent.role === "router" && <CrewCounts crew={crew} />}
      <div className="ml-auto flex shrink-0 gap-1.5">
        {agent.state === "asleep" ? (
          <Button variant="outline" size="sm" title="Resume" onClick={() => setArchived(agent.id, false)}>
            <Play /> <FitLabel full="Resume" glyph={false} />
          </Button>
        ) : (
          <Button variant="outline" size="sm" title="Pause" onClick={() => interruptTurn(agent, isLive)} disabled={agent.state !== "working"}>
            <Pause /> <FitLabel full="Pause" glyph={false} />
          </Button>
        )}
        <Button variant="outline" size="sm" title="Archive" onClick={() => setArchived(agent.id, true)} disabled={agent.state === "asleep"}>
          <Archive /> <FitLabel full="Archive" glyph={false} />
        </Button>
      </div>
    </FitRow>
  );
}

function AgentBody({ agent, back }: { agent: Agent; back: string }) {
  const agents = agentStore.use();
  const isLive = liveStore.use();
  const tasks = taskStore.use();
  const objectives = objectiveStore.use();
  const signals = signalStore.use();
  const typed = typedStore.use()[agent.id] ?? [];

  const parent = agents.find(a => a.id === agent.parent);
  const crew = agents.filter(a => a.parent === agent.id);
  const siblings = agents.filter(a => hasText(a.parent) && a.parent === agent.parent && a.id !== agent.id);
  const objective = objectives.find(o => o.id === agent.objectiveId);
  const task = tasks.find(t => agent.taskIds.includes(t.id) && t.status !== "done") ?? tasks.find(t => t.id === agent.taskIds.at(-1));
  const routedHere = signals.filter(s => {
    const p = pathOf(s, agents);
    return agent.role === "router" ? p.routers.includes(agent.id) : p.agents.includes(agent.id);
  });
  const typedHere = new Set<string>();
  for (const l of typed) if (l.kind === "user") typedHere.add(l.text);
  const history = routedHere.filter(s => !(s.source === "isaac" && typedHere.has(s.text))).toReversed();
  const lines = [...transcriptFor(agent, { crew, parent, task, signals: history }), ...typed, closing[agent.state](agent)];

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden pb-3">
      <AgentHeader agent={agent} crew={crew} back={back} isLive={isLive} />
      <div className="flex min-h-0 flex-1 gap-4 pl-3">
        {isLive ? (
          <section className="dark min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background p-2">
            <Terminal key={agent.id} id={agent.id} />
          </section>
        ) : (
          <Tty agent={agent} lines={lines} />
        )}
        {agent.browser === true && <BrowserPane key={agent.id} id={agent.id} />}
        <aside className="-my-3 flex w-1/4 min-w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l px-4 py-4">
          {agent.role === "router" ? <RouterSidebar router={agent} /> : <WorkerSidebar known={{ agent, parent, objective, task }} isLive={isLive} routedHere={routedHere} siblings={siblings} />}
        </aside>
      </div>
    </div>
  );
}

function ShellOrNothing({ id, back }: { id: string; back: string }) {
  const shell = shellStore.use().find(x => x.id === id);
  return shell ? <ShellPage shell={shell} back={back} /> : <p className="p-6 text-muted-foreground">No agent {id}.</p>;
}

function SentryOrShell({ id, back }: { id: string; back: string }) {
  const sentry = sentryStore.use().find(s => s.id === id);
  return sentry ? <SentryPage sentry={sentry} back={back} /> : <ShellOrNothing id={id} back={back} />;
}

export function AgentPage({ id, back }: { id: string; back: string }) {
  const agent = agentStore.use().find(a => a.id === id);
  return agent ? <AgentBody agent={agent} back={back} /> : <SentryOrShell id={id} back={back} />;
}
