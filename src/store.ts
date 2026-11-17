import { useSyncExternalStore } from "react";
import { NOW_AT, sentries as seedSources, threads as seedThreads, agents as seedAgents, signals as seedSignals, tasks as seedTasks, objectives as seedObjectives, type Block, type Event, type Agent, type SentrySession, type Signal, type Status } from "./mock";

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
export async function openSubthread(threadId: string, messageId: string) {
  const t = isLive() ? await api("/api/threads", { parent: { thread: threadId, message: messageId } }) : threadStore.get().find(x => x.parentId === threadId && x.parentMessageId === messageId);
  if (t) location.hash = `thread/${t.id}`;
}

/** Isaac marks a thread done, or reopens it; it stays readable and postable either way. */
export async function setResolved(threadId: string, resolved: boolean) {
  if (isLive()) return void (await api(`/api/threads/${threadId}`, { resolved }, "PATCH"));
  threadStore.set(all => all.map(t => (t.id === threadId ? { ...t, resolved: resolved ? { at: NOW_AT } : undefined } : t)));
}

/** Isaac puts a thread away until a time, or brings it back now (null); his own message in it brings it back too. */
export async function setPaused(threadId: string, paused: { until: number; said: string } | null) {
  if (isLive()) return void (await api(`/api/threads/${threadId}`, { paused }, "PATCH"));
  threadStore.set(all => all.map(t => (t.id === threadId ? { ...t, resolved: undefined, paused: paused ? { until: new Date(paused.until).toISOString(), at: NOW_AT, said: paused.said, posts: 0 } : undefined } : t)));
}

/** Flips a thread between a command (an ack and one result) and a conversation; its routers hear of it. */
export async function setKind(threadId: string, kind: "command" | "conversation") {
  if (isLive()) return void (await api(`/api/threads/${threadId}/kind`, { kind }));
  threadStore.set(all => all.map(t => (t.id === threadId ? { ...t, kind } : t)));
}

/** A command result on one of his messages becomes an ordinary reply, and the routers are told to talk that message through. */
export async function answerHere(threadId: string, messageId: string) {
  if (isLive()) return void (await api(`/api/threads/${threadId}/messages/${messageId}/conversation`));
  threadStore.set(all => all.map(t => (t.id === threadId ? { ...t, messages: t.messages.map(m => (m.re === messageId ? { ...m, re: undefined } : m)) } : t)));
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

