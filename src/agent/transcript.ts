import type { Agent, Signal, Task } from "@/mock";
import { createStore } from "@/store";

export type Line =
  | { kind: "system" | "user" | "assistant" | "router" | "sentry"; text: string }
  | { kind: "tool"; name: string; arg: string; result: string }
  | { kind: "working"; text: string };

/** Lines typed into an agent's terminal this session, on top of the transcript it already had. */
export const typedStore = createStore<Record<string, Line[]>>({});

export const closing: Record<Agent["state"], (a: Agent) => Line> = {
  working: a => ({ kind: "working", text: a.doing }),
  waiting: a => ({ kind: "assistant", text: `${a.doing}. Parked until a sentry pings me.` }),
  idle: () => ({ kind: "assistant", text: "Idle until my router hands me work." }),
  asleep: a => ({ kind: "assistant", text: `${a.doing}. Nothing left in my scope, archiving myself.` }),
};

/** A plausible transcript built from what the agent is known to have done, up to but not including its current state. */
export function transcriptFor(agent: Agent, crew: Agent[], parent: Agent | undefined, task: Task | undefined, signals: Signal[]): Line[] {
  const lines: Line[] = [{ kind: "system", text: `yarn · ${agent.id} · ${agent.role}${parent ? ` · spawned by ${parent.id}` : ""}` }];

  if (agent.role === "router") {
    lines.push({ kind: "router", text: `You route "${agent.scope}". Keep your agents busy, ask Isaac only in a thread, about decisions truly his.` });
    lines.push({ kind: "tool", name: "Read", arg: "objective.md", result: "Read 42 lines" });
    for (const w of crew) {
      lines.push({ kind: "tool", name: "Spawn", arg: w.id, result: `${w.id} started` });
      lines.push({ kind: "assistant", text: `${w.id}: ${w.doing}.` });
    }
  } else {
    lines.push({ kind: "router", text: `[from ${parent?.id ?? "router"}] ${task?.title ?? agent.doing}.${parent?.scope ? ` Scope: ${parent.scope}.` : ""}` });
    lines.push({ kind: "assistant", text: "Reading the brief and finding where this lives before changing anything." });
    lines.push({ kind: "tool", name: "Bash", arg: "git log --oneline -5", result: "5 commits" });
    lines.push({ kind: "tool", name: "Grep", arg: task ? task.title.split(" ").slice(0, 2).join(" ") : agent.id, result: "Found 7 files" });
    if (task?.pr) {
      lines.push({ kind: "tool", name: "Edit", arg: "3 files", result: "+84 −21" });
      lines.push({ kind: "tool", name: "Bash", arg: "gh pr create --fill", result: `Opened #${task.pr}` });
    }
  }

  for (const s of signals) {
    lines.push(s.source === "isaac" ? { kind: "user", text: s.text } : { kind: "sentry", text: `[${s.source}] ${s.target} · ${s.text}` });
  }
  return lines;
}
