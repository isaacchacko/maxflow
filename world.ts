import type { ServerWebSocket } from "bun";
import { onPublish } from "./bus";
import type { WsData } from "./sessions";
import { world } from "./world-rows";

export { judged, prStates } from "./world-session";

type World = Awaited<ReturnType<typeof world>>;
const COLLECTIONS = ["objectives", "agents", "tasks", "threads", "signals", "sentries"] as const;
const COLLECTION_NAMES = new Set<string>(COLLECTIONS);
const WS_OPEN = 1;
const FIRST_BUILD_AFTER_AN_EVENT_MS = 100;
const BUILDS_AT_MOST_EVERY_MS = 300;
const BUILD_WHILE_A_TAB_FOLLOWS_EVERY_MS = 2000;
const GET_REUSES_A_BUILD_UNDER_MS = 1000;
type Built = { v: number; at: number; w: World; json?: string; items: Record<string, Map<string, string>>; order: Record<string, string>; rest: Record<string, string> };
type Patch = { upsert: Record<string, unknown[]>; remove: Record<string, string[]>; order: Record<string, string[]>; set: Record<string, unknown> };
export let built: Built | undefined;
const worldBuild: { isDirty: boolean; building: Promise<Built> | undefined; timer: ReturnType<typeof setTimeout> | undefined; lastBuildAt: number } = {
  isDirty: true,
  building: undefined,
  timer: undefined,
  lastBuildAt: 0,
};
export const worldClients = new Set<ServerWebSocket<WsData>>();

function collectionChanges(list: { id: string }[], items: Map<string, string>, previousItems: Map<string, string>, isReordered: boolean) {
  return {
    up: list.filter((x) => previousItems.get(x.id) !== items.get(x.id)),
    gone: previousItems
      .keys()
      .filter((id) => !items.has(id))
      .toArray(),
    order: isReordered ? items.keys().toArray() : undefined,
  };
}

function collectionsOf(w: World, previous: Built | undefined) {
  const items: Built["items"] = {};
  const order: Built["order"] = {};
  const patch: Pick<Patch, "upsert" | "remove" | "order"> = { upsert: {}, remove: {}, order: {} };
  for (const c of COLLECTIONS) {
    const list: { id: string }[] = w[c];
    const m = new Map(list.map((x) => [x.id, JSON.stringify(x)]));
    items[c] = m;
    order[c] = m.keys().toArray().join("\n");
    const previousItems = previous?.items[c];
    if (previous === undefined || previousItems === undefined) continue;
    const changes = collectionChanges(list, m, previousItems, order[c] !== previous.order[c]);
    if (changes.up.length > 0) patch.upsert[c] = changes.up;
    if (changes.gone.length > 0) patch.remove[c] = changes.gone;
    if (changes.order) patch.order[c] = changes.order;
  }
  return { items, order, patch };
}

function restOf(w: World, previous: Built | undefined) {
  const rest: Built["rest"] = {};
  const set: Patch["set"] = {};
  for (const [k, val] of Object.entries(w)) {
    if (COLLECTION_NAMES.has(k)) continue;
    rest[k] = JSON.stringify(val);
    if (previous && rest[k] !== previous.rest[k]) set[k] = val;
  }
  return { rest, set };
}

const hasChanges = (patch: Patch) => Object.values(patch).some((o) => Object.keys(o).length > 0);

function sendPatch(from: number, v: number, patch: Patch) {
  const msg = JSON.stringify({ type: "patch", from, v, ...patch });
  for (const ws of worldClients) ws.sendText(msg);
}

async function buildWorld(): Promise<Built> {
  const w = await world();
  const previous = built;
  const { items, order, patch: collectionPatch } = collectionsOf(w, previous);
  const { rest, set } = restOf(w, previous);
  const patch: Patch = { ...collectionPatch, set };
  if (previous !== undefined && !hasChanges(patch)) {
    previous.at = Date.now();
    return previous;
  }
  const from = previous?.v;
  built = { v: (from ?? 0) + 1, at: Date.now(), w, items, order, rest };
  if (from !== undefined && worldClients.size > 0) sendPatch(from, built.v, patch);
  return built;
}

async function buildAndSettle() {
  try {
    return await buildWorld();
  } finally {
    worldBuild.building = undefined;
    if (worldBuild.isDirty) scheduleWorld();
  }
}

async function rebuildWorld(): Promise<Built> {
  if (worldBuild.building !== undefined) return worldBuild.building;
  worldBuild.isDirty = false;
  worldBuild.lastBuildAt = Date.now();
  worldBuild.building = buildAndSettle();
  return worldBuild.building;
}

function scheduleWorld() {
  if (worldBuild.timer !== undefined || worldClients.size === 0) return;
  worldBuild.timer = setTimeout(
    () => {
      worldBuild.timer = undefined;
      void rebuildWorld();
    },
    Math.max(FIRST_BUILD_AFTER_AN_EVENT_MS, worldBuild.lastBuildAt + BUILDS_AT_MOST_EVERY_MS - Date.now()),
  );
}

export async function freshWorld() {
  if (worldBuild.building !== undefined) await worldBuild.building;
  return built && !worldBuild.isDirty && Date.now() - built.at < GET_REUSES_A_BUILD_UNDER_MS ? built : rebuildWorld();
}
onPublish.add(() => {
  worldBuild.isDirty = true;
  scheduleWorld();
});
setInterval(() => {
  if (worldClients.size > 0 && Date.now() - worldBuild.lastBuildAt >= BUILD_WHILE_A_TAB_FOLLOWS_EVERY_MS) void rebuildWorld();
}, 500);
export async function openWorld(ws: ServerWebSocket<WsData>) {
  worldClients.add(ws);
  const b = await freshWorld();
  if (ws.readyState === WS_OPEN) ws.sendText(JSON.stringify({ type: "world", v: b.v, world: b.w }));
}
