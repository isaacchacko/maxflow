import { useSyncExternalStore } from "react";
import { tasks as seed, type Block, type Event, type Status } from "./mock";

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

export const taskStore = createStore(seed);
export const editedStore = createStore<Record<string, number>>({});

export function moveTask(id: string, status: Status) {
  taskStore.set(tasks => tasks.map(t => (t.id === id ? { ...t, status } : t)));
}

export function addEvent(id: string, event: Event) {
  taskStore.set(tasks => tasks.map(t => (t.id === id ? { ...t, events: [...t.events, event] } : t)));
}

export function putBlock(taskId: string, block: Block) {
  taskStore.set(tasks =>
    tasks.map(t => {
      if (t.id !== taskId) return t;
      const exists = t.page.some(b => b.id === block.id);
      return { ...t, page: exists ? t.page.map(b => (b.id === block.id ? block : b)) : [...t.page, block] };
    }),
  );
  editedStore.set(e => ({ ...e, [`${taskId}/${block.id}`]: Date.now() }));
}

export function removeBlock(taskId: string, blockId: string) {
  taskStore.set(tasks => tasks.map(t => (t.id === taskId ? { ...t, page: t.page.filter(b => b.id !== blockId) } : t)));
}
