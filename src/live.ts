import type { Agent, Objective, Sentry, SentrySession, Signal, Task, Thread } from "./mock";
import { agentStore, changes, liveStore, objectiveStore, nameStore, prStore, type Pr, refreshed, sentryStore, signalStore, sourceStore, taskStore, threadStore } from "./store";

type World = { objectives: Objective[]; agents: Agent[]; tasks: Task[]; threads: Thread[]; signals: Signal[]; sentries: SentrySession[]; names?: Record<string, string>; prs: Record<string, Pr> };

const SOURCE_SENTRY: Partial<Record<Sentry["id"], string>> = { gh: "gh", slack: "slack" };
const LABEL: Record<Sentry["id"], string> = { isaac: "You", gh: "GitHub", slack: "Slack", agent: "Agents", sentry: "Sentries", maxflow: "yarn" };
const EVERY: Partial<Record<Sentry["id"], string>> = { gh: "30s", slack: "60s" };

function sourcesOf(sentries: SentrySession[]): Sentry[] {
  return (Object.keys(LABEL) as Sentry["id"][]).map(id => {
    const name = SOURCE_SENTRY[id];
    const s = name ? sentries.find(x => x.name === name) : undefined;
    return { id, label: LABEL[id], state: !name ? "live" : s?.running ? "polling" : "backoff", every: EVERY[id], watching: [] };
  });
}

// The world as the server last sent it, and its version: patches over the socket apply to it, and the stores show it.
let current: World | undefined;
let version = 0;

function apply(w: World) {
  objectiveStore.set(w.objectives);
  agentStore.set(w.agents);
  taskStore.set(w.tasks);
  threadStore.set(w.threads);
  signalStore.set(w.signals);
  sentryStore.set(w.sentries);
  sourceStore.set(sourcesOf(w.sentries));
  prStore.set(w.prs ?? {});
  nameStore.set(w.names ?? {});
  // Threads an agent asked him in wait on him; the tab says how many, as v1's questions did.
  pending = w.threads.filter(t => t.asks).length;
  setTitle();
  liveStore.set(true);
}

// The tab reads "yarn · <view>", with how many threads wait on him in front.
let pending = 0;
function setTitle() {
  const view = location.hash.slice(1).split("/")[0] || "inbox";
  const name = view === "inbox" ? "Threads" : view === "threads" ? "Thread map" : `${view[0]!.toUpperCase()}${view.slice(1)}`;
  document.title = `${pending ? `(${pending}) ` : ""}yarn · ${name}`;
}
addEventListener("hashchange", setTitle);

// The health sentry answers in the server's place while it is down; reloading lands on its panic page, which reloads back
// once the server is up. While nothing answers at all (a restart, before the panic page takes the port) the page waits it out:
// reloading then lands on the browser's own "can't connect" page, which never retries and needed ⌘R. When the server answers
// again after that, the page reloads, so a restart's new code and a fresh world come in by themselves.
let misses = 0;
async function refresh() {
  const n = changes.n;
  try {
    // A tab that already has this version is answered 304 and keeps its copy.
    const res = await fetch("/api/world", { cache: "no-cache" });
    if (res.headers.has("x-yarn-panic") || res.headers.has("x-maxflow-down")) return location.reload();
    if (res.ok) {
      if (misses >= 2) return location.reload();
      misses = 0;
      const w = await res.json();
      // Fetched across one of his own changes, it may not have it yet; the refetch that change asks for brings it.
      if (changes.n === n) (current = w), (version = Number(res.headers.get("x-world-v")) || version), apply(w);
    }
  } catch {
    if (liveStore.get()) misses++;
  }
}

type Patch = { from: number; v: number; upsert: Record<string, { id: string }[]>; remove: Record<string, string[]>; order: Record<string, string[]>; set: Record<string, unknown> };
// A patch is what changed by entity since the version this tab has; a collection's order comes along when it changed.
function patch(w: World, p: Patch): World {
  const next = { ...w } as Record<string, unknown>;
  for (const c of new Set([...Object.keys(p.upsert), ...Object.keys(p.remove), ...Object.keys(p.order)])) {
    const byId = new Map((next[c] as { id: string }[]).map(x => [String(x.id), x]));
    for (const x of p.upsert[c] ?? []) byId.set(String(x.id), x);
    for (const id of p.remove[c] ?? []) byId.delete(id);
    next[c] = p.order[c] ? p.order[c].flatMap(id => byId.get(id) ?? []) : [...byId.values()];
  }
  return Object.assign(next, p.set) as World;
}

// The server pushes the world's changes over a socket; while one of his own changes is in flight they wait for its refetch, so an
// older state can't draw over it. With the socket down the tab polls, as it always did.
let socket: WebSocket | undefined;
function follow() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/world/ws`);
  ws.onopen = () => (socket = ws);
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data)) as ({ type: "world"; v: number; world: World } | ({ type: "patch" } & Patch));
    if (m.type === "world") (current = m.world), (version = m.v);
    else if (!current || m.from !== version) return ws.send("full");
    else (current = patch(current, m)), (version = m.v);
    if (!changes.busy) apply(current!);
  };
  ws.onclose = () => {
    if (socket === ws) socket = undefined;
    setTimeout(follow, 2000);
  };
}

async function loop() {
  if (!socket) await refresh();
  setTimeout(loop, liveStore.get() ? 1500 : 5000);
}

/** Loads the world once before the first render, then keeps it fresh; a change made through the API refreshes at once. */
export async function startLive() {
  await refresh();
  follow();
  refreshed.current = refresh;
  setTimeout(loop, 1500);
}
