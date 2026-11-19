import { useSyncExternalStore } from "react";
import { NOW_AT, localAt, type Thread, type Block, type Event, type Agent, type Objective, type SentrySession, type Shell, type Signal, type Status, type Task } from "./mock";
import { isRecord } from "../shared/guards";
import { sentries as seedSources, threads as seedThreads, agents as seedAgents, signals as seedSignals, tasks as seedTasks, objectives as seedObjectives } from "./mock-seed";

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
export const threadStore = createStore(seedThreads);
export const movedStore = createStore<Thread[]>([]);
export const editedStore = createStore<Record<string, number>>({});
export const sourceStore = createStore(seedSources);
export const sentryStore = createStore<SentrySession[]>([]);
export const shellStore = createStore<Shell[]>([]);
export const nameStore = createStore<Record<string, string>>({});
export type Pr = { title: string; state: "open" | "merged" | "closed" };
export const prStore = createStore<Record<string, Pr>>({});
export const liveStore = createStore(false);
const isLive = () => liveStore.get();
export const refreshed: { current?: () => Promise<void> } = {};

const jsonRequest = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });

export async function api(path: string, body?: unknown, method = "POST"): Promise<unknown> {
  const res = await fetch(path, jsonRequest(method, body));
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  await refreshed.current?.();
  if (res.status === 204) return null;
  const json: unknown = await res.json();
  return json;
}

const idOf = (value: unknown) => (isRecord(value) && typeof value["id"] === "string" ? value["id"] : undefined);

export const ownChanges = { count: 0, inFlight: 0 };

async function optimistic(threadId: string, change: (t: Thread) => Thread, path: string, body: unknown) {
  const store = movedStore.get().some(t => t.id === threadId) ? movedStore : threadStore;
  const before = store.get().find(t => t.id === threadId);
  ownChanges.count += 1;
  store.set(all => all.map(t => (t.id === threadId ? change(t) : t)));
  if (!isLive()) return;
  ownChanges.inFlight += 1;
  try {
    const res = await fetch(path, jsonRequest("PATCH", body));
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  } catch (error) {
    if (before) store.set(all => all.map(t => (t.id === threadId ? before : t)));
    throw error;
  } finally {
    ownChanges.count += 1;
    ownChanges.inFlight -= 1;
    void refreshed.current?.();
  }
}

export type PageRef = `task/${string}` | `objective/${string}`;

function update(ref: PageRef, fn: (subject: { events: Event[]; page: Block[] }) => { events: Event[]; page: Block[] }) {
  const [type, id] = ref.split("/", 2);
  const updated = <T extends { id: string; events: Event[]; page: Block[] }>(items: T[]) => items.map(item => (item.id === id ? { ...item, ...fn(item) } : item));
  if (type === "task") taskStore.set(updated);
  else objectiveStore.set(updated);
}

export function moveTask(id: string, status: Status) {
  taskStore.set(tasks => tasks.map(t => (t.id === id ? { ...t, status } : t)));
}

export function addEvent(ref: PageRef, event: Event) {
  update(ref, s => ({ ...s, events: [...s.events, event] }));
}

export function putBlock(ref: PageRef, block: Block) {
  if (isLive()) void api("/api/pages", { ref, block });
  update(ref, s => {
    const isOnPage = s.page.some(b => b.id === block.id);
    return { ...s, page: isOnPage ? s.page.map(b => (b.id === block.id ? block : b)) : [...s.page, block] };
  });
  editedStore.set(e => ({ ...e, [`${ref}/${block.id}`]: Date.now() }));
}

export function removeBlock(ref: PageRef, blockId: string) {
  update(ref, s => ({ ...s, page: s.page.filter(b => b.id !== blockId) }));
}

export function sendChat(text: string) {
  void api("/api/signals", { text });
}

export function addSignal(signal: Omit<Signal, "id" | "at">) {
  const id = `s${Date.now()}`;
  signalStore.set(all => [{ ...signal, id, at: NOW_AT }, ...all]);
  return id;
}

export function pathOf(signal: Signal, agents: Agent[]) {
  const byId = new Map(agents.map(a => [a.id, a]));
  const reached = signal.routedTo.map(id => byId.get(id)).filter(a => a !== undefined);
  const workers = reached.filter(a => a.role === "worker");
  const workersRouters = workers
    .map(w => w.parent)
    .filter(id => id !== undefined)
    .filter(id => byId.has(id));
  const routers = new Set([...reached.filter(a => a.role === "router").map(a => a.id), ...workersRouters]);
  const objectives = new Set(
    [...routers]
      .map(r => byId.get(r)?.objectiveId)
      .filter(o => o !== undefined),
  );
  return { objectives: [...objectives], routers: [...routers], agents: workers.map(w => w.id) };
}

export function splitRouter(objectiveId: string, scope: string) {
  if (isLive()) {
    void api(`/api/objectives/${objectiveId}/routers`, { scope });
    return;
  }
  const all = agentStore.get();
  const n = all.filter(a => a.objectiveId === objectiveId && a.role === "router").length + 1;
  const id = `r-${objectiveId.split("-", 1)[0] ?? objectiveId}-${n}`;
  const narrowed = all.map(a => (a.objectiveId === objectiveId && a.scope === "Whole objective" ? { ...a, scope: "Rest of the objective" } : a));
  agentStore.set([...narrowed, { id, role: "router", objectiveId, scope, taskIds: [], state: "idle", doing: "Just split off, reading the objective" }]);
  return id;
}

type LocalMock = { tasks: Task[]; objectives: Objective[]; agents: Agent[]; signals: Signal[]; threads?: Thread[] };
const isLocalMock = (value: unknown): value is LocalMock =>
  isRecord(value) && ["tasks", "objectives", "agents", "signals"].every(key => Array.isArray(value[key])) && (value["threads"] === undefined || Array.isArray(value["threads"]));

async function fetchIfReachable(path: string) {
  try {
    return await fetch(path);
  } catch {
    return null;
  }
}

export async function loadLocalMock() {
  if (isLive()) return;
  const res = await fetchIfReachable("/mock.local.json");
  if (res?.ok !== true) return;
  let local: unknown;
  try {
    local = await res.json();
  } catch (error) {
    console.warn("mock.local.json unreadable, using built-in mock", error);
    return;
  }
  if (!isLocalMock(local)) return;
  taskStore.set(local.tasks);
  objectiveStore.set(local.objectives);
  agentStore.set(local.agents);
  signalStore.set(local.signals);
  if (local.threads !== undefined) threadStore.set(local.threads);
}

export async function startThread(text: string) {
  return api("/api/threads", { text });
}

export function postToThread(threadId: string, from: string, text: string, nudge?: "subthread") {
  if (isLive()) {
    void api(`/api/threads/${threadId}/messages`, { text, nudge });
    return;
  }
  threadStore.set(all => all.map(t => (t.id === threadId ? { ...t, resolved: undefined, paused: undefined, messages: [...t.messages, { from, at: NOW_AT, text, nudge }] } : t)));
}

const openThreadPage = (id: string) => {
  location.hash = `thread/${id}`;
};

export async function openSubthread(threadId: string, messageId: string, open = openThreadPage) {
  const subthreadId = isLive() ? idOf(await api("/api/threads", { parent: { thread: threadId, message: messageId } })) : threadStore.get().find(x => x.parentId === threadId && x.parentMessageId === messageId)?.id;
  if (subthreadId !== undefined) open(subthreadId);
}

export async function setResolved(threadId: string, isResolved: boolean) {
  await optimistic(threadId, t => ({ ...t, resolved: isResolved ? { at: localAt() } : undefined }), `/api/threads/${threadId}`, { resolved: isResolved });
}

export async function setPinned(threadId: string, isPinned: boolean) {
  const next = Math.max(0, ...threadStore.get().map(t => (t.pinned ? t.pinned.order + 1 : 0)));
  await optimistic(threadId, t => ({ ...t, pinned: isPinned ? (t.pinned ?? { at: localAt(), order: next }) : undefined }), `/api/threads/${threadId}`, { pinned: isPinned });
}

export async function setPinOrder(ids: string[]) {
  threadStore.set(all => all.map(t => (t.pinned && ids.includes(t.id) ? { ...t, pinned: { ...t.pinned, order: ids.indexOf(t.id) } } : t)));
  if (isLive()) await api("/api/pins", { order: ids }, "PATCH");
}

export async function setPaused(threadId: string, paused: { until: number; said: string; wake?: string } | null) {
  const show = (t: Thread): Thread => ({ ...t, resolved: paused ? undefined : t.resolved, paused: paused ? { until: localAt(new Date(paused.until)), at: localAt(), said: paused.said, posts: 0, wake: paused.wake } : undefined });
  await optimistic(threadId, show, `/api/threads/${threadId}`, { paused });
}

export function markAskShown(threadId: string) {
  if (isLive()) void fetch(`/api/threads/${threadId}/shown`, { method: "POST" });
}

export function spawnWorker(router: Agent) {
  if (isLive()) {
    void api("/api/sessions", { name: "new worker", parent: router.id, cwd: router.cwd, cmd: ["claude", "--permission-mode", "bypassPermissions"] });
    return;
  }
  const n = agentStore.get().filter(a => a.parent === router.id).length + 1;
  const id = `${router.id.replace(/^r-/, "")}-${n}`;
  agentStore.set(all => [...all, { id, role: "worker", objectiveId: router.objectiveId, parent: router.id, taskIds: [], state: "idle", doing: "Waiting for a brief" }]);
}

export function setArchived(id: string, isArchived: boolean) {
  if (isLive()) {
    void api(`/api/sessions/${id}`, { archived: isArchived }, "PATCH");
    return;
  }
  agentStore.set(all => all.map(a => (a.id === id ? { ...a, state: isArchived ? "asleep" : "working" } : a)));
}

export const TODO_STATES = ["todo", "doing", "done", "cancelled"] as const;
export type TodoState = (typeof TODO_STATES)[number];
export type Todo = { id: string; text: string; day: string; state: TodoState; at: string; threadIds: string[] };
export const isOpen = (t: Todo) => t.state === "todo" || t.state === "doing";
export const todoStore = createStore<Todo[]>([]);
const isTodo = (value: unknown): value is Todo => isRecord(value) && typeof value["id"] === "string";
const isTodoList = (value: unknown): value is Todo[] => Array.isArray(value) && value.every(isTodo);

export async function loadTodos() {
  if (!isLive()) return;
  const res = await fetch("/api/todos");
  if (!res.ok) return;
  const todos: unknown = await res.json();
  if (isTodoList(todos)) todoStore.set(todos);
}

async function sendTodo(path: string, method: string, body?: unknown) {
  if (!isLive()) return;
  try {
    const res = await fetch(path, jsonRequest(method, body));
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    if (res.status === 204) return null;
    const saved: unknown = await res.json();
    return isTodo(saved) ? saved : null;
  } catch (error) {
    await loadTodos();
    throw error;
  }
}

export async function addTodo(text: string, day: string) {
  const draft: Todo = { id: `new-${Date.now()}`, text, day, state: "todo", at: new Date().toISOString(), threadIds: [] };
  todoStore.set(all => [...all, draft]);
  const saved = await sendTodo("/api/todos", "POST", { text, day });
  if (saved) todoStore.set(all => all.map(t => (t.id === draft.id ? saved : t)));
}

export async function editTodo(id: string, edit: Partial<Pick<Todo, "text" | "day" | "state">>) {
  todoStore.set(all => all.map(t => (t.id === id ? { ...t, ...edit } : t)));
  await sendTodo(`/api/todos/${id}`, "PATCH", edit);
}

export async function deleteTodo(id: string) {
  todoStore.set(all => all.filter(t => t.id !== id));
  await sendTodo(`/api/todos/${id}`, "DELETE");
}

export async function tagThread(todoId: string, threadId: string, isTagged: boolean) {
  const others = (t: Todo) => t.threadIds.filter(x => x !== threadId);
  todoStore.set(all => all.map(t => (t.id === todoId ? { ...t, threadIds: isTagged ? [...others(t), threadId] : others(t) } : t)));
  await sendTodo(`/api/todos/${todoId}/threads/${threadId}`, isTagged ? "POST" : "DELETE");
}

export async function startTodoThread(todo: Todo) {
  const threadId = idOf(await startThread(todo.text));
  if (threadId !== undefined) await tagThread(todo.id, threadId, true);
}
