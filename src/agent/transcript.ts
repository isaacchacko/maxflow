import type { Agent, Signal, Task } from "@/mock";
import { hasText } from "@/lib/utils";
import { createStore } from "@/store";

export type Line =
  | { kind: "system" | "user" | "assistant" | "router" | "sentry"; text: string }
  | { kind: "tool"; name: string; arg: string; result: string }
  | { kind: "working"; text: string };

export const typedStore = createStore<Record<string, Line[]>>({});

export const closing: Record<Agent["state"], (a: Agent) => Line> = {
  working: a => ({ kind: "working", text: a.doing }),
  waiting: a => ({ kind: "assistant", text: `${a.doing}. Parked until a sentry pings me.` }),
  idle: () => ({ kind: "assistant", text: "Idle until my router hands me work." }),
  asleep: a => ({ kind: "assistant", text: `${a.doing}. Nothing left in my scope, archiving myself.` }),
};

type Known = { crew: Agent[]; parent: Agent | undefined; task: Task | undefined; signals: Signal[] };

function routerOpening(agent: Agent, crew: Agent[]): Line[] {
  return [
    { kind: "router", text: `You route "${agent.scope}". Keep your agents busy, ask Isaac only in a thread, about decisions truly his.` },
    { kind: "tool", name: "Read", arg: "objective.md", result: "Read 42 lines" },
    ...crew.flatMap((w): Line[] => [
      { kind: "tool", name: "Spawn", arg: w.id, result: `${w.id} started` },
      { kind: "assistant", text: `${w.id}: ${w.doing}.` },
    ]),
  ];
}

function workerOpening(agent: Agent, parent: Agent | undefined, task: Task | undefined): Line[] {
  const scope = hasText(parent?.scope) ? ` Scope: ${parent.scope}.` : "";
  const pr = task?.pr;
  const opened: Line[] =
    pr === undefined || pr === 0
      ? []
      : [
          { kind: "tool", name: "Edit", arg: "3 files", result: "+84 −21" },
          { kind: "tool", name: "Bash", arg: "gh pr create --fill", result: `Opened #${pr}` },
        ];
  return [
    { kind: "router", text: `[from ${parent?.id ?? "router"}] ${task?.title ?? agent.doing}.${scope}` },
    { kind: "assistant", text: "Reading the brief and finding where this lives before changing anything." },
    { kind: "tool", name: "Bash", arg: "git log --oneline -5", result: "5 commits" },
    { kind: "tool", name: "Grep", arg: task ? task.title.split(" ").slice(0, 2).join(" ") : agent.id, result: "Found 7 files" },
    ...opened,
  ];
}

const signalLine = (s: Signal): Line => (s.source === "isaac" ? { kind: "user", text: s.text } : { kind: "sentry", text: `[${s.source}] ${s.target} · ${s.text}` });

export function transcriptFor(agent: Agent, { crew, parent, task, signals }: Known): Line[] {
  const spawnedBy = parent ? ` · spawned by ${parent.id}` : "";
  return [
    { kind: "system", text: `yarn · ${agent.id} · ${agent.role}${spawnedBy}` },
    ...(agent.role === "router" ? routerOpening(agent, crew) : workerOpening(agent, parent, task)),
    ...signals.map(signalLine),
  ];
}
