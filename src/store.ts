import { useSyncExternalStore } from "react";
import { tasks as seed, type Message, type Status } from "./mock";

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
export const draftStore = createStore<{ text: string; from: Message["from"] }>({ text: "", from: "isaac" });

export function moveTask(id: string, status: Status) {
  taskStore.set(tasks => tasks.map(t => (t.id === id ? { ...t, status } : t)));
}

export function addMessage(id: string, message: Message) {
  taskStore.set(tasks => tasks.map(t => (t.id === id ? { ...t, messages: [...t.messages, message] } : t)));
}
