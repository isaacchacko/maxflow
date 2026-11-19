import { waitWords } from "@/components/Waiting";
import { objectiveStatus, type Agent, type Objective, type Signal, type Task, type Thread } from "@/mock";
import type { NodeMeta } from "@/views/SearchPalette";
import { trace, type Path } from "./trace";

type Everything = { signals: Signal[]; objectives: Objective[]; agents: Agent[]; threads: Thread[]; tasks: Task[]; paths: Map<string, Path> };

const eventNode = (s: Signal, paths: Map<string, Path>): NodeMeta => ({
  id: `sig:${s.id}`,
  kind: "event",
  label: s.target,
  detail: s.text,
  text: `${s.text} ${s.target}`,
  source: s.source,
  objectives: paths.get(s.id)?.objectives ?? [],
});

function objectiveNode(o: Objective, statusOfTask: Map<string, Task["status"]>): NodeMeta {
  const vision = o.page.find(b => b.kind === "vision");
  const goal = vision?.kind === "vision" ? vision.goal : "";
  return {
    id: `obj:${o.id}`,
    kind: "objective",
    label: o.id,
    detail: o.title,
    text: `${o.title} ${o.id} ${goal}`,
    status: objectiveStatus(o.taskIds.map(t => statusOfTask.get(t)).filter(s => s !== undefined)),
    objectives: [o.id],
  };
}

function agentDetail(a: Agent, task: Task | undefined) {
  if (a.role === "router") return `${String(a.scope)} · ${a.doing}`;
  return `${a.doing}${task ? ` · ${task.title}` : ""}`;
}

const agentSearchText = (a: Agent, task: Task | undefined, agents: Agent[]) => `${a.id} ${a.name ?? ""} ${a.scope ?? ""} ${a.doing} ${a.wait ? waitWords(a.wait, agents) : ""} ${task?.title ?? ""} ${task?.pr ?? ""}`;

function agentNode(a: Agent, tasks: Task[], agents: Agent[]): NodeMeta {
  const task = tasks.find(t => a.taskIds.includes(t.id));
  const kind = a.role === "router" ? "router" : "agent";
  return {
    id: `${kind}:${a.id}`,
    kind,
    label: a.name ?? a.id,
    detail: agentDetail(a, task),
    text: agentSearchText(a, task, agents),
    state: a.state,
    status: task?.status,
    objectives: [a.objectiveId],
  };
}

const threadNode = (t: Thread): NodeMeta => ({
  id: `thread:${t.id}`,
  kind: "thread",
  label: t.routerIds.join(", "),
  detail: t.title,
  text: `${t.title} ${t.messages.map(m => m.text).join(" ")}`,
  objectives: [t.objectiveId],
});

export function searchNodes({ signals, objectives, agents, threads, tasks, paths }: Everything): NodeMeta[] {
  const statusOfTask = new Map(tasks.map(t => [t.id, t.status]));
  return [...signals.map(s => eventNode(s, paths)), ...objectives.map(o => objectiveNode(o, statusOfTask)), ...agents.map(a => agentNode(a, tasks, agents)), ...threads.map(threadNode)];
}

export function hitsWithWholeRoutes(hits: NodeMeta[], { signals, agents, threads, paths }: Everything) {
  const kept = new Set<string>();
  for (const n of hits) {
    kept.add(n.id);
    const wired = n.kind === "thread" ? threadWiring(n.id, threads) : trace(n.id, signals, paths, agents);
    for (const id of wired) kept.add(id);
  }
  return kept;
}

function threadWiring(id: string, threads: Thread[]) {
  const t = threads.find(x => `thread:${x.id}` === id);
  return t ? [`obj:${t.objectiveId}`, ...t.routerIds.map(r => `router:${r}`)] : [];
}

export const shownBy = (kept: Set<string> | undefined, threads: Thread[]) => (id: string) => {
  if (!kept || kept.has(id)) return true;
  if (!id.startsWith("thread:")) return false;
  const t = threads.find(x => `thread:${x.id}` === id);
  return t?.routerIds.some(r => kept.has(`router:${r}`)) === true;
};
