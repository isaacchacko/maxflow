import { useSyncExternalStore } from "react";
import { NOW_AT, agents as seedAgents, signals as seedSignals, tasks as seedTasks, objectives as seedObjectives, type Block, type Event, type Agent, type Signal, type Status } from "./mock";

export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return {
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      listeners.forEach(l => l());
    },
    use: () => useSyncExternalStore(subscribe, () => state),
  };
}

export const taskStore = createStore(seedTasks);
export const objectiveStore = createStore(seedObjectives);
export const agentStore = createStore(seedAgents);
export const signalStore = createStore(seedSignals);
export const editedStore = createStore<Record<string, number>>({});

/** A page is addressed the same way as its route: "task/t1" or "objective/overdue". */
export type PageRef = `task/${string}` | `objective/${string}`;

function update(ref: PageRef, fn: (subject: { events: Event[]; page: Block[] }) => { events: Event[]; page: Block[] }) {
  const [type, id] = ref.split("/");
  const store = (type === "task" ? taskStore : objectiveStore) as unknown as ReturnType<typeof createStore<{ id: string; events: Event[]; page: Block[] }[]>>;
  store.set(items => items.map(item => (item.id === id ? { ...item, ...fn(item) } : item)));
}

export function moveTask(id: string, status: Status) {
  taskStore.set(tasks => tasks.map(t => (t.id === id ? { ...t, status } : t)));
}

export function addEvent(ref: PageRef, event: Event) {
  update(ref, s => ({ ...s, events: [...s.events, event] }));
}

export function putBlock(ref: PageRef, block: Block) {
  update(ref, s => {
    const exists = s.page.some(b => b.id === block.id);
    return { ...s, page: exists ? s.page.map(b => (b.id === block.id ? block : b)) : [...s.page, block] };
  });
  editedStore.set(e => ({ ...e, [`${ref}/${block.id}`]: Date.now() }));
}

export function removeBlock(ref: PageRef, blockId: string) {
  update(ref, s => ({ ...s, page: s.page.filter(b => b.id !== blockId) }));
}

export function addSignal(signal: Omit<Signal, "id" | "at">) {
  const id = `s${Date.now()}`;
  signalStore.set(all => [{ ...signal, id, at: NOW_AT }, ...all]);
  return id;
}

/** The path a signal took: objectives it reached, the routers that took it, and the agents they handed it to. */
export function pathOf(signal: Signal, agents: Agent[]) {
  const byId = new Map(agents.map(a => [a.id, a]));
  const reached = signal.routedTo.map(id => byId.get(id)).filter((a): a is Agent => !!a);
  const workers = reached.filter(a => a.role === "worker");
  const routers = new Set([...reached.filter(a => a.role === "router").map(a => a.id), ...workers.map(w => w.parent!).filter(Boolean)]);
  const objectives = new Set([...routers].map(r => byId.get(r)!.objectiveId));
  return { objectives: [...objectives], routers: [...routers], agents: workers.map(w => w.id) };
}

export function splitRouter(objectiveId: string, scope: string) {
  const all = agentStore.get();
  const n = all.filter(a => a.objectiveId === objectiveId && a.role === "router").length + 1;
  const id = `r-${objectiveId.split("-")[0]}-${n}`;
  const narrowed = all.map(a => (a.objectiveId === objectiveId && a.scope === "Whole objective" ? { ...a, scope: "Rest of the objective" } : a));
  agentStore.set([...narrowed, { id, role: "router", objectiveId, scope, taskIds: [], state: "idle", doing: "Just split off, reading the objective" }]);
  return id;
}

/** Swaps in mock.local.json when the server has one: real work that stays out of the public repo. */
export async function loadLocalMock() {
  const res = await fetch("/mock.local.json").catch(() => undefined);
  if (!res?.ok) return;
  const local = await res.json().catch((e: unknown) => console.warn("mock.local.json unreadable, using built-in mock", e));
  if (!local) return;
  taskStore.set(local.tasks);
  objectiveStore.set(local.objectives);
  agentStore.set(local.agents);
  signalStore.set(local.signals);
}
