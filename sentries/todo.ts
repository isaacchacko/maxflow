#!/usr/bin/env bun
// todo sentry's feed: runs beside the todo agent (sentries/todo.md) in its pane. It hands the agent, in one batch FLUSH_MS after the
// first change, the threads that got new messages (a new thread, a post, a split) and the open todos he added since the last batch, with
// his open todos and their tags, so the agent tags a thread under the todo it works on. No model call happens until there is a batch.
// `bun sentries/todo.ts tag|untag <todo> <thread>` is how the agent tags: it records its own tags, and refuses to untag one it didn't make.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE as base, STATE_DIR } from "../instance";

const STATE_FILE = join(STATE_DIR, "todo-state.json");
// The tags the agent made itself, the only ones it may take off.
const TAGS_FILE = join(STATE_DIR, "todo-tags.json");
const FLUSH_MS = Number(process.env.TODO_FLUSH_MS ?? 3 * 60_000);
// Open todos older than this are left out of a batch; a new todo is matched against threads active within it.
const RECENT_MS = 14 * 86_400_000;
const ACTIVE_MS = 3 * 86_400_000;
const MAX_THREADS = 25;

type Todo = { id: string; day: string; state: string; text: string; threadIds?: string[] };
type Msg = { id: string; from: string; at: number; text: string };
type Thread = { id: string; title: string; objective: string; messages: Msg[]; resolved?: unknown; mergedInto?: string };
type Tag = { todo: string; thread: string; at: number };
// known: every thread id seen at the last batch, so a thread he started (whose signal names no thread) comes in as new.
type State = { seq: number; threads: string[]; todosSeen: string[]; known: string[]; firstAt: number; started?: boolean };
const state: State = { seq: 0, threads: [], todosSeen: [], known: [], firstAt: 0, ...(existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}) };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state));
const loadTags = (): Tag[] => (existsSync(TAGS_FILE) ? JSON.parse(readFileSync(TAGS_FILE, "utf8")) : []);
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };
const log = (line: string) => console.log(`${new Date().toLocaleTimeString()}  ${line}`);
const short = (text: string, n: number) => { const t = text.replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n)}…`; };
const get = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T;
const isOpen = (t: Todo) => (t.state === "todo" || t.state === "doing") && Date.now() - Date.parse(t.day) < RECENT_MS;

async function tagCommand(verb: string, todo: string, thread: string) {
  const tags = loadTags();
  const mine = tags.some((t) => t.todo === todo && t.thread === thread);
  if (verb === "untag" && !mine) return console.error(`${thread} on ${todo} was not tagged by the todo sentry; leave it`), process.exit(1);
  const res = await fetch(`${base}/api/todos/${todo}/threads/${thread}`, { method: verb === "tag" ? "POST" : "DELETE", headers: caller });
  if (!res.ok) return console.error(await res.text()), process.exit(1);
  const next = verb === "tag" ? (mine ? tags : [...tags, { todo, thread, at: Date.now() }]) : tags.filter((t) => !(t.todo === todo && t.thread === thread));
  writeFileSync(TAGS_FILE, JSON.stringify(next));
  console.log(`${verb === "tag" ? "tagged" : "untagged"} ${thread} ${verb === "tag" ? "on" : "from"} ${todo}`);
}

function describe(t: Thread, objectives: Record<string, string>) {
  const msgs = t.messages ?? [];
  const lines = [msgs[0], ...msgs.slice(1).slice(-3)].filter(Boolean).map((m) => `  - ${m.from === "isaac" ? "Isaac" : m.from}: ${short(m.text, 300)}`);
  return `- ${t.id} "${t.title}"${objectives[t.objective] ? ` (objective "${objectives[t.objective]}")` : ""}${t.resolved ? " [resolved]" : ""}\n${lines.join("\n")}`;
}

async function flush() {
  const [todos, threads, objectiveList] = await Promise.all([get<Todo[]>("/api/todos"), get<Thread[]>("/api/threads"), get<{ id: string; title: string }[]>("/api/objectives")]);
  const open = todos.filter(isOpen);
  const fresh = open.filter((t) => !state.todosSeen.includes(t.id));
  state.todosSeen = todos.map((t) => t.id);
  const byId = new Map(threads.map((t) => [t.id, t]));
  // A new todo is matched against the threads active lately, beside the ones that just changed.
  const ids = new Set([...state.threads, ...threads.filter((t) => state.known.length && !state.known.includes(t.id)).map((t) => t.id)]);
  state.known = threads.map((t) => t.id);
  if (fresh.length)
    for (const t of threads) if (!t.resolved && !t.mergedInto && Date.now() - (t.messages.at(-1)?.at ?? 0) < ACTIVE_MS) ids.add(t.id);
  const changed = [...ids].flatMap((id) => byId.get(id) ?? []).filter((t) => !t.mergedInto)
    .toSorted((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0)).slice(0, MAX_THREADS);
  state.threads = [];
  state.firstAt = 0;
  if (!open.length || !changed.length) return log(`nothing to hand (${open.length} open todos, ${changed.length} threads)`);
  const objectives = Object.fromEntries(objectiveList.map((o) => [o.id, o.title]));
  const tags = loadTags();
  const todoLines = open.map((t) => {
    const tagged = (t.threadIds ?? []).map((id) => `${id}${tags.some((g) => g.todo === t.id && g.thread === id) ? " (yours)" : " (his)"}`);
    return `- ${t.id} ${t.day} ${t.state}${fresh.includes(t) ? " NEW" : ""}: ${t.text}${tagged.length ? `  tagged: ${tagged.join(", ")}` : ""}`;
  });
  const text = `[maxflow todo] ${changed.length} thread${changed.length > 1 ? "s" : ""} to check against his ${open.length} open todos${fresh.length ? ` (${fresh.length} new)` : ""}.\n\nOpen todos:\n${todoLines.join("\n")}\n\nThreads:\n${changed.map((t) => describe(t, objectives)).join("\n")}`;
  const res = await fetch(`${base}/api/sessions/${process.env.MAXFLOW_SESSION}/notify`, { method: "POST", headers: caller, body: JSON.stringify({ text }) });
  if (!res.ok) return log(`notify failed: ${await res.text()}`);
  log(`handed ${changed.length} threads against ${open.length} open todos`);
}

if (import.meta.main && (process.argv[2] === "tag" || process.argv[2] === "untag")) {
  if (!process.argv[3] || !process.argv[4]) console.error("bun sentries/todo.ts tag|untag <todo id> <thread id>"), process.exit(1);
  await tagCommand(process.argv[2], process.argv[3], process.argv[4]);
} else if (import.meta.main) {
  const PID_FILE = join(STATE_DIR, "todo-feed.pid");
  try {
    const old = readFileSync(PID_FILE, "utf8").trim();
    if (Bun.spawnSync(["ps", "-p", old, "-o", "command="]).stdout.toString().includes("sentries/todo.ts")) process.kill(Number(old));
  } catch {}
  writeFileSync(PID_FILE, String(process.pid));
  while (!(await fetch(`${base}/api/sessions`).then((r) => r.ok, () => false))) await Bun.sleep(2_000);
  if (!state.started) {
    // The first batch checks his open todos against the threads active lately, once the agent beside it is up.
    state.seq = Number((await fetch(`${base}/api/events?topic=none&after=now`)).headers.get("x-maxflow-seq") ?? 0);
    await Bun.sleep(20_000);
    await flush();
    state.started = true;
    save();
  }
  log("todo feed up");
  for (;;) {
    try {
      const wait = state.firstAt ? Math.max(1_000, state.firstAt + FLUSH_MS - Date.now()) : 60_000;
      const events = await get<{ seq: number; topic: string; data: any }[]>(`/api/events?topic=**&after=${state.seq}&wait=${wait}`);
      for (const e of events) {
        state.seq = e.seq;
        // A thread he starts is a signal naming no thread yet; the batch finds it among the threads it hasn't seen.
        if (e.topic === "signal/isaac") { state.firstAt ||= Date.now(); continue; }
        // A post (his, an agent's, the feed's), a split or a routing moves a thread's topic; status lines, pins and pauses don't.
        if (!e.topic.startsWith("thread/") || !e.data?.thread || !(e.data.from || e.data.split || e.data.pending)) continue;
        for (const id of [e.data.thread, e.data.split].filter(Boolean)) if (!state.threads.includes(id)) state.threads.push(id);
        state.firstAt ||= Date.now();
      }
      // A todo he added since the last batch starts one too; reading the list is cheap and carries no model call.
      if (!state.firstAt) {
        const todos = await get<Todo[]>("/api/todos");
        if (todos.some((t) => isOpen(t) && !state.todosSeen.includes(t.id))) state.firstAt = Date.now();
        else state.todosSeen = todos.map((t) => t.id);
      }
      if (state.firstAt && Date.now() - state.firstAt >= FLUSH_MS) await flush();
      save();
    } catch (e) {
      log(`tick failed: ${e}`);
      await Bun.sleep(10_000);
    }
    // Exits with the agent's pane, or once a newer feed took over.
    if (process.ppid === 1 || readFileSync(PID_FILE, "utf8") !== String(process.pid)) process.exit(0);
  }
}
