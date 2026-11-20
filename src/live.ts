import { hasText } from "@/lib/utils";
import type { Agent, Objective, Sentry, SentrySession, Shell, Signal, Task, Thread } from "./mock";
import { markResurfaced } from "./threads/seen";
import { agentStore, ownChanges, liveStore, loadTodos, movedStore, objectiveStore, nameStore, prStore, type Pr, refreshed, sentryStore, shellStore, signalStore, sourceStore, taskStore, threadStore } from "./store";
import { isRecord } from "../shared/guards";
import { cursorFrom, fireCursor } from "./cursors/store";
import { canvasChanged } from "./views/docs/canvas-api";
import { claim, heldKeys, isHeld, onLand, onRelease } from "./cursors/holds";
import { reloadResource } from "@/lib/effects";

type World = { objectives: Objective[]; agents: Agent[]; tasks: Task[]; threads: Thread[]; signals: Signal[]; sentries: SentrySession[]; shells?: Shell[]; names?: Record<string, string>; prs?: Record<string, Pr> };
type Patch = { from: number; v: number; upsert: Record<string, { id: string | number }[]>; remove: Record<string, string[]>; order: Record<string, string[]>; set: Record<string, unknown> };

const isWorld = (value: unknown): value is World => isRecord(value) && ["objectives", "agents", "tasks", "threads", "signals", "sentries"].every(key => Array.isArray(value[key]));
const isPatch = (value: unknown): value is Patch =>
  isRecord(value) && typeof value["from"] === "number" && typeof value["v"] === "number" && isRecord(value["upsert"]) && isRecord(value["remove"]) && isRecord(value["order"]) && isRecord(value["set"]);

const SOURCE_SENTRY: Partial<Record<Sentry["id"], string>> = { gh: "gh", slack: "slack" };
const LABEL: Record<Sentry["id"], string> = { isaac: "You", gh: "GitHub", slack: "Slack", agent: "Agents", sentry: "Sentries", yarn: "yarn" };
const EVERY: Partial<Record<Sentry["id"], string>> = { gh: "30s", slack: "60s" };
const SERVER_DOWN_MISSES_BEFORE_RELOAD = 2;

function sourceState(sentryName: string | undefined, sentries: SentrySession[]): Sentry["state"] {
  if (!hasText(sentryName)) return "live";
  return sentries.find(x => x.name === sentryName)?.running === true ? "polling" : "backoff";
}

function sourcesOf(sentries: SentrySession[]): Sentry[] {
  return (Object.keys(LABEL) as Sentry["id"][]).map(id => ({ id, label: LABEL[id], state: sourceState(SOURCE_SENTRY[id], sentries), every: EVERY[id], watching: [] }));
}

const live: { world: World | undefined; shown: World | undefined; version: number; threadsAskingHim: number; serverMisses: number; socket: WebSocket | undefined } = {
  world: undefined,
  shown: undefined,
  version: 0,
  threadsAskingHim: 0,
  serverMisses: 0,
  socket: undefined,
};

function viewName(view: string) {
  if (view === "inbox") return "Threads";
  if (view === "threads") return "Thread map";
  return `${view.charAt(0).toUpperCase()}${view.slice(1)}`;
}

function setTitle() {
  const first = location.hash.slice(1).split("/", 1)[0];
  const asking = live.threadsAskingHim > 0 ? `(${live.threadsAskingHim}) ` : "";
  document.title = `${asking}yarn · ${viewName(hasText(first) ? first : "inbox")}`;
}
addEventListener("hashchange", setTitle);

const HELD_COLLECTIONS = new Set(["objectives", "agents", "tasks", "threads"]);

function heldBack(list: { id: string | number }[], was: { id: string | number }[], id: string) {
  const before = was.find(x => String(x.id) === id);
  const i = list.findIndex(x => String(x.id) === id);
  if (before && i !== -1) return list.with(i, before);
  if (before) return [...list, before];
  return i === -1 ? list : list.toSpliced(i, 1);
}

// constraint: an entity a cursor is still reaching for stays as it was on screen, so its change lands under the cursor instead of before it
function withHeld(w: World): World {
  const was = live.shown;
  if (!was) return w;
  const next: Record<string, unknown> = { ...w };
  for (const key of heldKeys()) {
    const c = key.slice(0, key.indexOf(":"));
    const id = key.slice(key.indexOf(":") + 1);
    if (HELD_COLLECTIONS.has(c)) next[c] = heldBack(next[c] as { id: string | number }[], (was as unknown as Record<string, { id: string | number }[]>)[c] ?? [], id);
  }
  return next as World;
}

function apply(world: World) {
  const w = withHeld(world);
  live.shown = w;
  objectiveStore.set(w.objectives);
  agentStore.set(w.agents);
  taskStore.set(w.tasks);
  threadStore.set(w.threads.filter(t => !t.movedTo));
  movedStore.set(w.threads.filter(t => t.movedTo));
  markResurfaced(w.threads);
  signalStore.set(w.signals);
  sentryStore.set(w.sentries);
  shellStore.set(w.shells ?? []);
  sourceStore.set(sourcesOf(w.sentries));
  prStore.set(w.prs ?? {});
  nameStore.set(w.names ?? {});
  live.threadsAskingHim = w.threads.filter(t => t.asks).length;
  setTitle();
  liveStore.set(true);
}

function worldVersion(res: Response) {
  const v = Number(res.headers.get("x-world-v"));
  return v === 0 || Number.isNaN(v) ? live.version : v;
}

async function refresh() {
  const changesBefore = ownChanges.count;
  try {
    const res = await fetch("/api/world", { cache: "no-cache" });
    if (res.headers.has("x-yarn-panic") || res.headers.has("x-maxflow-down")) {
      location.reload();
      return;
    }
    if (!res.ok) return;
    if (live.serverMisses >= SERVER_DOWN_MISSES_BEFORE_RELOAD) {
      location.reload();
      return;
    }
    live.serverMisses = 0;
    const w: unknown = await res.json();
    const isAcrossOwnChange = ownChanges.count !== changesBefore;
    if (isAcrossOwnChange || !isWorld(w)) return;
    live.world = w;
    live.version = worldVersion(res);
    apply(w);
  } catch {
    if (liveStore.get()) live.serverMisses += 1;
  }
}

function patchedCollection(items: unknown, c: string, p: Patch) {
  const byId = new Map((items as { id: string | number }[]).map(x => [String(x.id), x]));
  const upserted = p.upsert[c] ?? [];
  for (const x of upserted) byId.set(String(x.id), x);
  const removed = p.remove[c] ?? [];
  for (const id of removed) byId.delete(id);
  const order = p.order[c];
  return order ? order.map(id => byId.get(id)).filter(x => x !== undefined) : byId.values().toArray();
}

function patch(w: World, p: Patch): World {
  const next: Record<string, unknown> = { ...w };
  const collections = new Set([...Object.keys(p.upsert), ...Object.keys(p.remove), ...Object.keys(p.order)]);
  for (const c of collections) next[c] = patchedCollection(next[c], c, p);
  return Object.assign(next, p.set) as World;
}

const CLAIM_CAP_MS = 1200;

function canvasChangedWhenItsCursorLands(path: string, isClaimed: boolean) {
  const key = `canvas:${path}`;
  if (isClaimed) claim(key, CLAIM_CAP_MS);
  if (!isHeld(key)) {
    canvasChanged(path);
    return;
  }
  const stop = onLand(key, () => {
    stop();
    canvasChanged(path);
  });
}

function isSideMessage(m: unknown) {
  if (!isRecord(m)) return false;
  const cursor = cursorFrom(m);
  if (cursor) fireCursor(cursor);
  if (m["type"] === "canvas" && typeof m["path"] === "string") canvasChangedWhenItsCursorLands(m["path"], m["claimed"] === true);
  return cursor !== undefined || m["type"] === "canvas";
}

function onWorldMessage(ws: WebSocket, e: MessageEvent) {
  const m: unknown = JSON.parse(String(e.data));
  if (isSideMessage(m)) return;
  if (isRecord(m) && m["type"] === "world" && isWorld(m["world"]) && typeof m["v"] === "number") {
    live.world = m["world"];
    live.version = m["v"];
  } else if (live.world !== undefined && isPatch(m) && m.from === live.version) {
    live.world = patch(live.world, m);
    live.version = m.v;
  } else {
    ws.send("full");
    return;
  }
  if (ownChanges.inFlight === 0) apply(live.world);
}

function follow() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/world/ws`);
  ws.addEventListener("open", () => {
    live.socket = ws;
  });
  ws.addEventListener("message", e => onWorldMessage(ws, e));
  ws.addEventListener("close", () => {
    if (live.socket === ws) live.socket = undefined;
    setTimeout(follow, 2000);
  });
}

async function loop() {
  if (!live.socket) await refresh();
  setTimeout(() => {
    void loop();
  }, liveStore.get() ? 1500 : 5000);
}

onRelease(() => {
  if (live.world && ownChanges.inFlight === 0) apply(live.world);
});
onLand("todos", () => {
  void loadTodos();
});
onLand("docs", () => {
  void reloadResource("docs");
});

export async function startLive() {
  await refresh();
  follow();
  refreshed.current = refresh;
  setTimeout(() => {
    void loop();
  }, 1500);
}
