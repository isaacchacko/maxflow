import type { Agent, Thread } from "@/mock";

const ROW_GAP = 20;
const STACK_GAP = 6;

export type Columns = {
  objectives: { id: string }[];
  routers: Agent[];
  agents: Agent[];
  threads: Thread[];
  heightOf: (id: string) => number;
  isShown: (id: string) => boolean;
};

export function crewOf(routerId: string, agents: Agent[], isShown: (id: string) => boolean) {
  const all = agents.filter(w => w.parent === routerId);
  if (all.length === 0) return isShown(`empty:${routerId}`) ? [`empty:${routerId}`] : [];
  return all.map(w => `agent:${w.id}`).filter(isShown);
}

export function threadsBesideFirstRouter(routerId: string, threads: Thread[], isShown: (id: string) => boolean) {
  const own = threads.filter(t => t.routerIds[0] === routerId);
  if (own.length === 0) return isShown(`nothreads:${routerId}`) ? [`nothreads:${routerId}`] : [];
  return own.map(t => `thread:${t.id}`).filter(isShown);
}

function stackFrom(y: Map<string, number>, ids: string[], top: number, heightOf: (id: string) => number) {
  let stack = top;
  for (const id of ids) {
    y.set(id, stack);
    stack += heightOf(id) + STACK_GAP;
  }
  return stack;
}

function placeByObjective({ objectives, routers, heightOf, isShown }: Columns, y: Map<string, number>) {
  let top = 0;
  for (const o of objectives) {
    const own = routers.filter(r => r.objectiveId === o.id && isShown(`router:${r.id}`)).map(r => `router:${r.id}`);
    const isObjectiveShown = isShown(`obj:${o.id}`);
    if (!isObjectiveShown && own.length === 0) continue;
    if (isObjectiveShown) y.set(`obj:${o.id}`, top);
    const stack = stackFrom(y, own, top, heightOf);
    top = Math.max(top + (isObjectiveShown ? heightOf(`obj:${o.id}`) : 0), stack - STACK_GAP) + ROW_GAP;
  }
  return top;
}

function placeCompact({ objectives, heightOf, isShown }: Columns, y: Map<string, number>) {
  let top = 0;
  for (const o of objectives) {
    if (!isShown(`obj:${o.id}`)) continue;
    y.set(`obj:${o.id}`, top);
    top += heightOf(`obj:${o.id}`) + STACK_GAP * 2;
  }
  return top;
}

function placeByRouter({ objectives, routers, heightOf, isShown }: Columns, y: Map<string, number>, arePlacingRouters: boolean, stackOf: (routerId: string) => string[]) {
  let top = 0;
  for (const o of objectives) {
    const own = routers.filter(r => r.objectiveId === o.id);
    let hasAny = false;
    for (const r of own) {
      const isRouterShown = arePlacingRouters && isShown(`router:${r.id}`);
      const stackIds = stackOf(r.id);
      if (!isRouterShown && stackIds.length === 0) continue;
      hasAny = true;
      if (isRouterShown) y.set(`router:${r.id}`, top);
      const stack = stackFrom(y, stackIds, top, heightOf);
      top = Math.max(top + (isRouterShown ? heightOf(`router:${r.id}`) : 0), stack - STACK_GAP) + STACK_GAP * 2;
    }
    if (hasAny) top += ROW_GAP - STACK_GAP * 2;
  }
  return top;
}

export function layoutStructure(snap: number, columns: Columns) {
  const y = new Map<string, number>();
  const objectiveRows = placeByObjective(columns, y);
  const compact = snap === 0 ? placeCompact(columns, y) : 0;
  const agentRows = placeByRouter(columns, y, snap === 2, id => crewOf(id, columns.agents, columns.isShown));
  const threadRows = placeByRouter(columns, y, snap === 3, id => threadsBesideFirstRouter(id, columns.threads, columns.isShown));
  return { y, height: [compact, objectiveRows, agentRows, threadRows][snap] ?? 0 };
}
