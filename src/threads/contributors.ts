import type { Expression } from "@/components/AgentFace";
import { hasText } from "@/lib/utils";
import type { Agent, Thread, Wait } from "@/mock";

export type Contributor = { id: string; agent?: Agent | undefined; name: string; why: string; last?: string | undefined };
type Add = (id: string, why: string, last?: string) => void;
type Message = Thread["messages"][number];


const RANK: Record<string, number> = { working: 0, waiting: 1, idle: 2, asleep: 3 };
const UNKNOWN_STATE_RANK = 2;
const ENDED_RANK = 9;
const SESSION = /\b[0-9a-f]{8}\b/g;
const AGENT_REF = /\[\[(?:agent|router):([0-9a-f]{8})\]\]|#agent\/([0-9a-f]{8})/g;

function familyOf(t: Thread, threads: Thread[]) {
  const family: Thread[] = [];
  let generation = [t];
  while (generation.length > 0) {
    family.push(...generation);
    generation = generation.flatMap(parent => threads.filter(x => x.parentId === parent.id));
  }
  return family;
}

const isFunnelStandIn = (agent: Agent | undefined) => agent?.objectiveId === "unrouted" && agent.name === "funnel";

function collector(agents: Agent[], names: Record<string, string>) {
  const found = new Map<string, Contributor>();
  const add: Add = (id, why, last) => {
    const agent = agents.find(a => a.id === id);
    const isSession = agent !== undefined || hasText(names[id]);
    if (!isSession || isFunnelStandIn(agent)) return;
    const had = found.get(id);
    if (!had) {
      found.set(id, { id, agent, name: agent?.name ?? names[id] ?? id, why, last });
      return;
    }
    if (hasText(last) && (!hasText(had.last) || last > had.last)) had.last = last;
  };
  return { found, add };
}

function addAgentsOnIt(t: Thread, familyIds: Set<string>, agents: Agent[], add: Add) {
  const taskId = t.taskId;
  for (const a of agents) {
    if (hasText(taskId) && a.taskIds.includes(taskId)) add(a.id, "on its task");
    if (a.wait?.kind === "thread" && familyIds.has(a.wait.ref)) add(a.id, "waiting on it");
  }
}

function addFromMessage(m: Message, agents: Agent[], add: Add) {
  if (m.from !== "isaac" && !m.ext) add(m.from, "posted", m.at);
  for (const [, agentRef, linkRef] of m.text.matchAll(AGENT_REF)) add(agentRef ?? linkRef ?? "", "mentioned");
  for (const [id] of m.text.matchAll(SESSION)) if (agents.some(a => a.id === id)) add(id, "mentioned");
}

const rankOf = (c: Contributor) => (c.agent ? (RANK[c.agent.state] ?? UNKNOWN_STATE_RANK) : ENDED_RANK);
const recencyOf = (c: Contributor) => c.agent?.since ?? c.last ?? "";
function byRankThenMostRecent(a: Contributor, b: Contributor) {
  const byRank = rankOf(a) - rankOf(b);
  return byRank === 0 ? recencyOf(b).localeCompare(recencyOf(a)) : byRank;
}

export function contributorsOf(t: Thread, threads: Thread[], agents: Agent[], names: Record<string, string>): Contributor[] {
  const family = familyOf(t, threads);
  const { found, add } = collector(agents, names);
  for (const id of t.routerIds) add(id, "router");
  const pendingRouterIds = family.flatMap(x => x.pending?.routerIds ?? []);
  for (const id of pendingRouterIds) add(id, "router");
  if (t.asks) add(t.asks.sessionId, "asked you here", t.asks.since);
  addAgentsOnIt(t, new Set(family.map(x => x.id)), agents, add);
  const messages = family.flatMap(x => x.messages);
  for (const m of messages) addFromMessage(m, agents, add);
  return found.values().toArray().toSorted(byRankThenMostRecent);
}

function asleepWord(wait: Wait, t: Thread) {
  if (wait.kind === "thread" && wait.ref === t.id) return "asleep on this thread";
  if (wait.kind === "until") return `asleep until ${wait.desc}`;
  return `asleep on ${wait.kind}:${wait.ref}`;
}

export function stateOf(c: Contributor, t: Thread): { expression: Expression; word: string; at?: string | undefined } {
  const a = c.agent;
  if (!a) return { expression: "done", word: "done", at: c.last };
  if (t.asks?.sessionId === a.id) return { expression: "waiting", word: "waiting on you", at: t.asks.since };
  if (a.wait && a.wait.kind !== "done") return { expression: "asleep", word: asleepWord(a.wait, t), at: a.since };
  if (a.state === "working") return { expression: "working", word: "working", at: a.since };
  if (a.state === "waiting") return { expression: "waiting", word: "waiting", at: a.since };
  if (a.state === "asleep") return { expression: "asleep", word: "asleep", at: a.since };
  return { expression: "idle", word: "idle", at: a.since };
}
