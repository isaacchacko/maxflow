import { useSyncExternalStore } from "react";
import { agents as seedAgents, tasks as seedTasks, threads as seedThreads, type Block, type Event, type Status } from "./mock";

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
export const threadStore = createStore(seedThreads);
export const agentStore = createStore(seedAgents);
export const editedStore = createStore<Record<string, number>>({});

/** A page is addressed the same way as its route: "task/t1" or "thread/overdue". */
export type PageRef = `task/${string}` | `thread/${string}`;

function update(ref: PageRef, fn: (subject: { events: Event[]; page: Block[] }) => { events: Event[]; page: Block[] }) {
  const [type, id] = ref.split("/");
  const store = (type === "task" ? taskStore : threadStore) as unknown as ReturnType<typeof createStore<{ id: string; events: Event[]; page: Block[] }[]>>;
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
