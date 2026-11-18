import { useSyncExternalStore } from "react";
import { NOW_AT, localAt, type Thread, sentries as seedSources, threads as seedThreads, agents as seedAgents, signals as seedSignals, tasks as seedTasks, objectives as seedObjectives, type Block, type Event, type Agent, type SentrySession, type Signal, type Status } from "./mock";

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
export const editedStore = createStore<Record<string, number>>({});
export const sourceStore = createStore(seedSources);
export const sentryStore = createStore<SentrySession[]>([]);
/** Sessions that have ended, by the name they last went by. */
export const nameStore = createStore<Record<string, string>>({});
export type Pr = { title: string; state: "open" | "merged" | "closed" };
/** The PRs the gh sentry polls, keyed owner/repo#n in lower case. */
export const prStore = createStore<Record<string, Pr>>({});
/** True once the server answered with real data; until then, or with no server, the stores hold the mock. */
export const liveStore = createStore(false);
const isLive = () => liveStore.get();
/** Set by live.ts: refetches the world, so a change made through the API shows at once. */
export const refreshed: { current?: () => Promise<void> } = {};

export async function api(path: string, body?: unknown, method = "POST") {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  await refreshed.current?.();
  return res.status === 204 ? null : res.json();
}

/**
 * Bumped around each of his own changes; live.ts drops a world it fetched across one, so a poll that left before the server had
 * the change can't draw the old state back over it.
 */
// busy: how many are in flight; the world the server pushes meanwhile waits, as it may not have them yet.
export const changes = { n: 0, busy: 0 };

/**
 * His own change to a thread shows at once: it is made here first, then sent, and the world is fetched again in the background
 * to reconcile. Waiting for the server and a full world (over a megabyte, a few hundred ms to build) made pinning and resolving lag.
 * A change the server refuses is put back.
 */
async function optimistic(threadId: string, change: (t: Thread) => Thread, path: string, body: unknown) {
  const before = threadStore.get().find(t => t.id === threadId);
  changes.n++;
  threadStore.set(all => all.map(t => (t.id === threadId ? change(t) : t)));
  if (!isLive()) return;
  changes.busy++;
  try {
    const res = await fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  } catch (e) {
    if (before) threadStore.set(all => all.map(t => (t.id === threadId ? before : t)));
    throw e;
  } finally {
    changes.n++;
    changes.busy--;
    void refreshed.current?.();
  }
}

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
  if (isLive()) void api("/api/pages", { ref, block });
  update(ref, s => {
    const exists = s.page.some(b => b.id === block.id);
    return { ...s, page: exists ? s.page.map(b => (b.id === block.id ? block : b)) : [...s.page, block] };
  });
  editedStore.set(e => ({ ...e, [`${ref}/${block.id}`]: Date.now() }));
}

export function removeBlock(ref: PageRef, blockId: string) {
  update(ref, s => ({ ...s, page: s.page.filter(b => b.id !== blockId) }));
}

/** Isaac's chat from the event log: the server logs it and hands it to the funnel to route. */
export function sendChat(text: string) {
  void api("/api/signals", { text });
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
  const routers = new Set([...reached.filter(a => a.role === "router").map(a => a.id), ...workers.map(w => w.parent!).filter(id => byId.has(id))]);
  const objectives = new Set([...routers].map(r => byId.get(r)!.objectiveId));
  return { objectives: [...objectives], routers: [...routers], agents: workers.map(w => w.id) };
}

export function splitRouter(objectiveId: string, scope: string) {
  if (isLive()) return void api(`/api/objectives/${objectiveId}/routers`, { scope });
  const all = agentStore.get();
  const n = all.filter(a => a.objectiveId === objectiveId && a.role === "router").length + 1;
  const id = `r-${objectiveId.split("-")[0]}-${n}`;
  const narrowed = all.map(a => (a.objectiveId === objectiveId && a.scope === "Whole objective" ? { ...a, scope: "Rest of the objective" } : a));
  agentStore.set([...narrowed, { id, role: "router", objectiveId, scope, taskIds: [], state: "idle", doing: "Just split off, reading the objective" }]);
  return id;
}

/** Swaps in mock.local.json when the server has one: real work that stays out of the public repo. */
export async function loadLocalMock() {
  if (isLive()) return;
  const res = await fetch("/mock.local.json").catch(() => undefined);
  if (!res?.ok) return;
  const local = await res.json().catch((e: unknown) => console.warn("mock.local.json unreadable, using built-in mock", e));
  if (!local) return;
  taskStore.set(local.tasks);
  objectiveStore.set(local.objectives);
  agentStore.set(local.agents);
  signalStore.set(local.signals);
  if (local.threads) threadStore.set(local.threads);
}

/** Isaac's inbox: each message starts a thread, which the funnel hands to the router that should own it. */
export function startThread(text: string) {
  return api("/api/threads", { text });
}

export function postToThread(threadId: string, from: string, text: string, nudge?: "subthread") {
  if (isLive()) return void api(`/api/threads/${threadId}/messages`, { text, nudge });
  threadStore.set(all => all.map(t => (t.id === threadId ? { ...t, resolved: undefined, paused: undefined, messages: [...t.messages, { from, at: NOW_AT, text, nudge }] } : t)));
}

/** Opens the subthread under a message, making it on the first visit; a top thread's first message is the thread itself. */
export async function openSubthread(threadId: string, messageId: string, open = (id: string) => void (location.hash = `thread/${id}`)) {
  const t = isLive() ? await api("/api/threads", { parent: { thread: threadId, message: messageId } }) : threadStore.get().find(x => x.parentId === threadId && x.parentMessageId === messageId);
  if (t) open(t.id);
}

/** Isaac marks a thread done, or reopens it; it stays readable and postable either way. */
export async function setResolved(threadId: string, resolved: boolean) {
  await optimistic(threadId, t => ({ ...t, resolved: resolved ? { at: localAt() } : undefined }), `/api/threads/${threadId}`, { resolved });
}

/** Isaac pins a thread to his sidebar, at the end of his pins, or unpins it. */
export async function setPinned(threadId: string, pinned: boolean) {
  const next = Math.max(0, ...threadStore.get().map(t => (t.pinned ? t.pinned.order + 1 : 0)));
  await optimistic(threadId, t => ({ ...t, pinned: pinned ? (t.pinned ?? { at: localAt(), order: next }) : undefined }), `/api/threads/${threadId}`, { pinned });
}

/** The order he dragged his pins into, first to last; drawn at once, then kept by the server. */
export async function setPinOrder(ids: string[]) {
  threadStore.set(all => all.map(t => (t.pinned && ids.includes(t.id) ? { ...t, pinned: { ...t.pinned, order: ids.indexOf(t.id) } } : t)));
  if (isLive()) await api("/api/pins", { order: ids }, "PATCH");
}

/** Isaac puts a thread away until a time, or brings it back now (null); his own message in it brings it back too. */
export async function setPaused(threadId: string, paused: { until: number; said: string; wake?: string } | null) {
  const show = (t: Thread): Thread => ({ ...t, resolved: paused ? undefined : t.resolved, paused: paused ? { until: localAt(new Date(paused.until)), at: localAt(), said: paused.said, posts: 0, wake: paused.wake } : undefined });
  await optimistic(threadId, show, `/api/threads/${threadId}`, { paused });
}

/** His inbox drew an ask flagged: its agent's 3h default counts from the first time it did. */
export function markAskShown(threadId: string) {
  if (isLive()) void fetch(`/api/threads/${threadId}/shown`, { method: "POST" });
}

/** A blank worker under a router, which the router is told to brief. */
export function spawnWorker(router: Agent) {
  if (isLive()) return void api("/api/sessions", { name: "new worker", parent: router.id, cwd: router.cwd, cmd: ["claude", "--permission-mode", "bypassPermissions"] });
  const n = agentStore.get().filter(a => a.parent === router.id).length + 1;
  const id = `${router.id.replace(/^r-/, "")}-${n}`;
  agentStore.set(all => [...all, { id, role: "worker", objectiveId: router.objectiveId, parent: router.id, taskIds: [], state: "idle", doing: "Waiting for a brief" }]);
}

/** Archiving stops an agent's claude between turns to free its memory; unarchiving resumes the chat. */
export function setArchived(id: string, archived: boolean) {
  if (isLive()) return void api(`/api/sessions/${id}`, { archived }, "PATCH");
  agentStore.set(all => all.map(a => (a.id === id ? { ...a, state: archived ? "asleep" : "working" } : a)));
}


/** One of his todos, on a day: YYYY-MM-DD in his local time. Clicking its box steps it through the states in order. */
export const TODO_STATES = ["todo", "doing", "done", "cancelled"] as const;
export type TodoState = (typeof TODO_STATES)[number];
export type Todo = { id: string; text: string; day: string; state: TodoState; at: string };
/** Not started or in progress: what the calendar dots and From earlier count. */
export const isOpen = (t: Todo) => t.state === "todo" || t.state === "doing";
/** His todo list, kept by the server in its own file; fetched by the Todo page, not part of the world. */
export const todoStore = createStore<Todo[]>([]);

export async function loadTodos() {
  if (!isLive()) return;
  const res = await fetch("/api/todos");
  if (res.ok) todoStore.set(await res.json());
}

/** Each change shows at once, then is sent; one the server refuses is put back by fetching the list again. */
async function sendTodo(path: string, method: string, body?: unknown) {
  if (!isLive()) return;
  try {
    const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.status === 204 ? null : ((await res.json()) as Todo);
  } catch (e) {
    await loadTodos();
    throw e;
  }
}

export async function addTodo(text: string, day: string) {
  const draft: Todo = { id: `new-${Date.now()}`, text, day, state: "todo", at: new Date().toISOString() };
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
