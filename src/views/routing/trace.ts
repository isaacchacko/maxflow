import type { Agent, Signal } from "@/mock";
import { hasText } from "@/lib/utils";
import { sourceStore, type pathOf } from "@/store";

export type Path = ReturnType<typeof pathOf>;

type Wiring = { lit: Set<string>; byId: Map<string, Agent>; signals: Signal[]; paths: Map<string, Path>; agents: Agent[] };

const litRouter = (w: Wiring, r: string) => w.lit.add(`obj:${String(w.byId.get(r)?.objectiveId)}>router:${r}`);
const litAgent = (w: Wiring, a: string) => w.lit.add(`router:${String(w.byId.get(a)?.parent)}>agent:${a}`);
const litInto = (w: Wiring, s: Signal, o: string) => w.lit.add(`sig:${s.id}>obj:${o}`);

function litFullPath(w: Wiring, s: Signal) {
  const p = w.paths.get(s.id);
  if (!p) return;
  for (const o of p.objectives) litInto(w, s, o);
  for (const r of p.routers) litRouter(w, r);
  for (const a of p.agents) litAgent(w, a);
}

function litSource(w: Wiring, id: string) {
  for (const s of w.signals) if (s.source === id) litFullPath(w, s);
  const watched = sourceStore.get().find(x => x.id === id)?.watching.flatMap(x => x.routedTo) ?? [];
  const watchedObjectives = new Set(watched.map(a => w.byId.get(a)?.objectiveId).filter(o => hasText(o)));
  for (const o of watchedObjectives) w.lit.add(`src:${id}~obj:${o}`);
}

function litObjective(w: Wiring, id: string) {
  for (const a of w.agents) {
    if (a.objectiveId !== id) continue;
    if (a.role === "router") litRouter(w, a.id);
    else litAgent(w, a.id);
  }
  for (const s of w.signals) if (w.paths.get(s.id)?.objectives.includes(id) === true) litInto(w, s, id);
}

function litCrewOrSelf(w: Wiring, agent: Agent) {
  if (agent.role !== "router") {
    litAgent(w, agent.id);
    return;
  }
  for (const worker of w.agents) if (worker.parent === agent.id) litAgent(w, worker.id);
}

function litRouterOrAgent(w: Wiring, kind: "router" | "agent", id: string) {
  const agent = w.byId.get(id);
  if (!agent) return;
  const router = agent.role === "router" ? agent : w.byId.get(agent.parent ?? "");
  if (!router) return;
  litRouter(w, router.id);
  litCrewOrSelf(w, agent);
  const list = kind === "router" ? "routers" : "agents";
  for (const s of w.signals) if (w.paths.get(s.id)?.[list].includes(id) === true) litInto(w, s, router.objectiveId);
}

export function trace(focus: string, signals: Signal[], paths: Map<string, Path>, agents: Agent[]) {
  const w: Wiring = { lit: new Set(), byId: new Map(agents.map(a => [a.id, a])), signals, paths, agents };
  const kind = focus.slice(0, focus.indexOf(":"));
  const id = focus.slice(focus.indexOf(":") + 1);
  switch (kind) {
    case "sig": {
      const s = signals.find(x => x.id === id);
      if (s) litFullPath(w, s);
      break;
    }
    case "src": {
      litSource(w, id);
      break;
    }
    case "obj": {
      litObjective(w, id);
      break;
    }
    case "router":
    case "agent": {
      litRouterOrAgent(w, kind, id);
      break;
    }
    default: {
      break;
    }
  }
  return new Set([focus, ...[...w.lit].flatMap(k => k.split(/[>~]/))]);
}
