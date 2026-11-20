#!/usr/bin/env bun
import { yarnEnv, seqOf } from "../shared/legacy-maxflow";
import { BASE as base } from "../instance";
import { isRecord, stringOr } from "../shared/guards";
import { readStateJson, writeStateJson } from "../state";
import { isStillTheFeed, replaceOlderFeed, waitForServer } from "./feed-process";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("todo");

const STATE_FILE = "todo-state.json";
const TAGS_THE_AGENT_MADE_ITSELF = "todo-tags.json";
const FLUSH_MS = Number(process.env["TODO_FLUSH_MS"] ?? 3 * 60_000);
const OPEN_TODO_RECENT_MS = 14 * 86_400_000;
const THREAD_ACTIVE_MS = 3 * 86_400_000;
const MAX_THREADS = 25;
const FETCH_MS = 30_000;
const IDLE_WAIT_MS = 60_000;
const MIN_WAIT_MS = 1000;
const AGENT_STARTUP_MS = 20_000;
const RETRY_MS = 10_000;

type Todo = { id: string; day: string; state: string; text: string; threadIds?: string[] };
type Msg = { id: string; from: string; at: number; text: string };
type Thread = { id: string; title: string; objective: string; messages: Msg[]; resolved?: unknown; mergedInto?: string };
type Tag = { todo: string; thread: string; at: number };
type BusEvent = { seq: number; topic: string; data: unknown };
type State = { seq: number; threads: string[]; todosSeen: string[]; known: string[]; firstAt: number; started?: boolean };

const isTodo = (value: unknown): value is Todo =>
  isRecord(value) && typeof value["id"] === "string" && typeof value["day"] === "string" && typeof value["state"] === "string" && typeof value["text"] === "string";
const isThread = (value: unknown): value is Thread => isRecord(value) && typeof value["id"] === "string" && Array.isArray(value["messages"]);
const isTag = (value: unknown): value is Tag => isRecord(value) && typeof value["todo"] === "string" && typeof value["thread"] === "string";
const isBusEvent = (value: unknown): value is BusEvent => isRecord(value) && typeof value["seq"] === "number" && typeof value["topic"] === "string";
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
const isPartialState = (value: unknown): value is Partial<State> => isRecord(value);

const kept = readStateJson(STATE_FILE, isPartialState);
const state: State = { seq: 0, threads: [], todosSeen: [], known: [], firstAt: 0, ...kept };
const save = () => {
  writeStateJson(STATE_FILE, state);
};
const loadTags = (): Tag[] => {
  const tags = readStateJson(TAGS_THE_AGENT_MADE_ITSELF, isList);
  return (tags ?? []).filter(isTag);
};
const caller = { "x-yarn-from": yarnEnv("SESSION") ?? "" };
const log = (line: string) => {
  console.log(`${new Date().toLocaleTimeString()}  ${line}`);
};
const short = (text: string, n: number) => {
  const t = text.replaceAll(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};
const getJson = async (path: string, timeoutMs = FETCH_MS): Promise<unknown> => (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) })).json();
const listOf = async <T>(path: string, isItem: (value: unknown) => value is T) => {
  const list = await getJson(path);
  return Array.isArray(list) ? list.filter(isItem) : [];
};
const isOpen = (t: Todo) => (t.state === "todo" || t.state === "doing") && Date.now() - Date.parse(t.day) < OPEN_TODO_RECENT_MS;
const lastAt = (t: Thread) => t.messages.at(-1)?.at ?? 0;
const isMerged = (t: Thread) => (t.mergedInto ?? "") !== "";
const isResolved = (t: Thread) => t.resolved !== undefined && t.resolved !== null;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function tagCommand(verb: string, todo: string, thread: string) {
  const tags = loadTags();
  const isTaggedByAgent = tags.some((t) => t.todo === todo && t.thread === thread);
  if (verb === "untag" && !isTaggedByAgent) fail(`${thread} on ${todo} was not tagged by the todo sentry; leave it`);
  const res = await fetch(`${base}/api/todos/${todo}/threads/${thread}`, { method: verb === "tag" ? "POST" : "DELETE", headers: caller, signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) fail(await res.text());
  const tagged = isTaggedByAgent ? tags : [...tags, { todo, thread, at: Date.now() }];
  const next = verb === "tag" ? tagged : tags.filter((t) => !(t.todo === todo && t.thread === thread));
  writeStateJson(TAGS_THE_AGENT_MADE_ITSELF, next);
  console.log(`${verb === "tag" ? "tagged" : "untagged"} ${thread} ${verb === "tag" ? "on" : "from"} ${todo}`);
}

function describe(t: Thread, objectives: Record<string, string>) {
  const [first, ...rest] = t.messages;
  const shown = [first, ...rest.slice(-3)].filter((m): m is Msg => m !== undefined);
  const lines = shown.map((m) => `  - ${m.from === "isaac" ? "Isaac" : m.from}: ${short(m.text, 300)}`);
  const objective = objectives[t.objective] ?? "";
  return `- ${t.id} "${t.title}"${objective === "" ? "" : ` (objective "${objective}")`}${isResolved(t) ? " [resolved]" : ""}\n${lines.join("\n")}`;
}

function threadsToHand(threads: Thread[], hasFreshTodos: boolean) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const startedSinceLastBatch = state.known.length > 0 ? threads.filter((t) => !state.known.includes(t.id)).map((t) => t.id) : [];
  const ids = new Set([...state.threads, ...startedSinceLastBatch]);
  state.known = threads.map((t) => t.id);
  if (hasFreshTodos) {
    const active = threads.filter((t) => !isResolved(t) && !isMerged(t) && Date.now() - lastAt(t) < THREAD_ACTIVE_MS);
    for (const t of active) ids.add(t.id);
  }
  return [...ids]
    .flatMap((id) => byId.get(id) ?? [])
    .filter((t) => !isMerged(t))
    .toSorted((a, b) => lastAt(b) - lastAt(a))
    .slice(0, MAX_THREADS);
}

function todoLine(t: Todo, tags: Tag[], fresh: Todo[]) {
  const tagged = (t.threadIds ?? []).map((id) => `${id}${tags.some((g) => g.todo === t.id && g.thread === id) ? " (yours)" : " (his)"}`);
  return `- ${t.id} ${t.day} ${t.state}${fresh.includes(t) ? " NEW" : ""}: ${t.text}${tagged.length > 0 ? `  tagged: ${tagged.join(", ")}` : ""}`;
}

async function objectiveTitles() {
  const list = await listOf("/api/objectives", isRecord);
  return Object.fromEntries(list.map((o) => [stringOr(o["id"]), stringOr(o["title"])]));
}

async function flush() {
  const [todos, threads, objectives] = await Promise.all([listOf("/api/todos", isTodo), listOf("/api/threads", isThread), objectiveTitles()]);
  const open = todos.filter(isOpen);
  const fresh = open.filter((t) => !state.todosSeen.includes(t.id));
  state.todosSeen = todos.map((t) => t.id);
  const changed = threadsToHand(threads, fresh.length > 0);
  state.threads = [];
  state.firstAt = 0;
  if (open.length === 0 || changed.length === 0) {
    log(`nothing to hand (${open.length} open todos, ${changed.length} threads)`);
    return;
  }
  const tags = loadTags();
  const todoLines = open.map((t) => todoLine(t, tags, fresh));
  const heading = `[yarn todo] ${changed.length} thread${changed.length > 1 ? "s" : ""} to check against his ${open.length} open todos${fresh.length > 0 ? ` (${fresh.length} new)` : ""}.`;
  const text = `${heading}\n\nOpen todos:\n${todoLines.join("\n")}\n\nThreads:\n${changed.map((t) => describe(t, objectives)).join("\n")}`;
  const res = await fetch(`${base}/api/sessions/${String(yarnEnv("SESSION"))}/notify`, { method: "POST", headers: caller, body: JSON.stringify({ text }), signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) {
    log(`notify failed: ${await res.text()}`);
    return;
  }
  log(`handed ${changed.length} threads against ${open.length} open todos`);
}

const startBatchClock = () => {
  if (state.firstAt === 0) state.firstAt = Date.now();
};

function onEvent(e: BusEvent) {
  state.seq = e.seq;
  if (e.topic === "signal/isaac") {
    startBatchClock();
    return;
  }
  const data = isRecord(e.data) ? e.data : {};
  const thread = stringOr(data["thread"]);
  const doesMoveTopic = Boolean(data["from"]) || Boolean(data["split"]) || Boolean(data["pending"]);
  if (!doesMoveTopic || thread === "" || !e.topic.startsWith("thread/")) return;
  for (const id of [thread, stringOr(data["split"])]) if (id !== "" && !state.threads.includes(id)) state.threads.push(id);
  startBatchClock();
}

async function startBatchOnNewTodo() {
  const todos = await listOf("/api/todos", isTodo);
  if (todos.some((t) => isOpen(t) && !state.todosSeen.includes(t.id))) state.firstAt = Date.now();
  else state.todosSeen = todos.map((t) => t.id);
}

async function tickFeed() {
  const wait = state.firstAt === 0 ? IDLE_WAIT_MS : Math.max(MIN_WAIT_MS, state.firstAt + FLUSH_MS - Date.now());
  const events = await getJson(`/api/events?topic=**&after=${state.seq}&wait=${wait}`, wait + FETCH_MS);
  const busEvents = Array.isArray(events) ? events.filter(isBusEvent) : [];
  for (const e of busEvents) onEvent(e);
  if (state.firstAt === 0) await startBatchOnNewTodo();
  if (state.firstAt !== 0 && Date.now() - state.firstAt >= FLUSH_MS) await flush();
  save();
}

async function firstBatchOnceAgentIsUp() {
  const res = await fetch(`${base}/api/events?topic=none&after=now`, { signal: AbortSignal.timeout(FETCH_MS) });
  state.seq = Number(seqOf(res) ?? 0);
  await Bun.sleep(AGENT_STARTUP_MS);
  await flush();
  state.started = true;
  save();
}

async function runFeed() {
  replaceOlderFeed("todo");
  await waitForServer();
  if (state.started !== true) await firstBatchOnceAgentIsUp();
  log("todo feed up");
  for (;;) {
    try {
      await tickFeed();
    } catch (error) {
      log(`tick failed: ${String(error)}`);
      await Bun.sleep(RETRY_MS);
    }
    if (!isStillTheFeed("todo")) process.exit(0);
  }
}

const [verb = "", todoId = "", threadId = ""] = process.argv.slice(2);
if (import.meta.main && (verb === "tag" || verb === "untag")) {
  if (todoId === "" || threadId === "") fail("bun sentries/todo.ts tag|untag <todo id> <thread id>");
  await tagCommand(verb, todoId, threadId);
} else if (import.meta.main) {
  await runFeed();
}
