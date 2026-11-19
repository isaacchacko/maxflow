import type { Expression } from "@/components/AgentFace";
import type { Agent, Thread } from "@/mock";

/** Someone working on a thread: a live agent, or a session that has ended (`agent` absent), and why they count. */
export type Contributor = { id: string; agent?: Agent; name: string; why: string; last?: string };

const RANK: Record<string, number> = { working: 0, waiting: 1, idle: 2, asleep: 3 };
const SESSION = /\b[0-9a-f]{8}\b/g;
const AGENT_REF = /\[\[(?:agent|router):([0-9a-f]{8})\]\]|#agent\/([0-9a-f]{8})/g;

/**
 * Everyone working on a thread, as far as the world shows: its routers, the agents on its task, any agent asleep on it or asking him
 * in it, any that posted in it or its subthreads, and live agents its messages name. Working first, then waiting, idle, asleep, and
 * the ended ones last; most recent first within each.
 */
export function contributorsOf(t: Thread, threads: Thread[], agents: Agent[], names: Record<string, string>): Contributor[] {
  const family = [t];
  for (let i = 0; i < family.length; i++) family.push(...threads.filter(x => x.parentId === family[i]!.id));
  const ids = new Set(family.map(x => x.id));
  const found = new Map<string, Contributor>();
  const add = (id: string, why: string, last?: string) => {
    const agent = agents.find(a => a.id === id);
    // Only sessions: an objective, a sentry or the funnel's stand-in has no face of its own here.
    if (!agent && !names[id]) return;
    if (agent?.objectiveId === "unrouted" && agent.name === "funnel") return;
    const had = found.get(id);
    if (had) return void (last && (!had.last || last > had.last) && (had.last = last));
    found.set(id, { id, agent, name: agent?.name ?? names[id] ?? id, why, last });
  };
  for (const id of t.routerIds) add(id, "router");
  for (const x of family) x.pending?.routerIds.forEach(id => add(id, "router"));
  if (t.asks) add(t.asks.sessionId, "asked you here", t.asks.since);
  for (const a of agents) {
    if (t.taskId && a.taskIds.includes(t.taskId)) add(a.id, "on its task");
    if (a.wait?.kind === "thread" && ids.has(a.wait.ref)) add(a.id, "waiting on it");
  }
  for (const x of family)
    for (const m of x.messages) {
      if (m.from !== "isaac" && !m.ext) add(m.from, "posted", m.at);
      for (const [, a, b] of m.text.matchAll(AGENT_REF)) add((a ?? b)!, "mentioned");
      for (const [id] of m.text.matchAll(SESSION)) if (agents.some(a => a.id === id)) add(id, "mentioned");
    }
  return [...found.values()].sort((a, b) => (a.agent ? RANK[a.agent.state] ?? 2 : 9) - (b.agent ? RANK[b.agent.state] ?? 2 : 9) || (b.agent?.since ?? b.last ?? "").localeCompare(a.agent?.since ?? a.last ?? ""));
}

/** How a contributor's face looks and what to call its state: asleep on what it waits on, waiting on him, working, done. */
export function stateOf(c: Contributor, t: Thread): { expression: Expression; word: string; at?: string } {
  const a = c.agent;
  if (!a) return { expression: "done", word: "done", at: c.last };
  if (t.asks?.sessionId === a.id) return { expression: "waiting", word: "waiting on you", at: t.asks.since };
  if (a.wait && a.wait.kind !== "done") return { expression: "asleep", word: a.wait.kind === "thread" && a.wait.ref === t.id ? "asleep on this thread" : a.wait.kind === "until" ? `asleep until ${a.wait.desc}` : `asleep on ${a.wait.kind}:${a.wait.ref}`, at: a.since };
  if (a.state === "working") return { expression: "working", word: "working", at: a.since };
  if (a.state === "waiting") return { expression: "waiting", word: "waiting", at: a.since };
  if (a.state === "asleep") return { expression: "asleep", word: "asleep", at: a.since };
  return { expression: "idle", word: "idle", at: a.since };
}
