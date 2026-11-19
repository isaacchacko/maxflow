import { dig, type FeedThread, getTasks, getThreads, isOpen, log, post, shortened } from "./inbox-board";
import { type Routed, type Said, state } from "./inbox-state";
import { fetchSessions } from "./slack-sessions";

const DAY_MS = 86_400_000;
const FIRST_CONTEXT_MS = 2 * 3_600_000;
const CONTEXT_MAX = 12;
const CONVERSATION_MAX = 40;

export function remember(key: string, said: Said) {
  const list = (state.convo[key] ??= []);
  if (list.some((x) => x.at === said.at && x.text === said.text)) return;
  list.push(said);
  state.convo[key] = list
    .filter((x) => Date.now() - x.at < DAY_MS)
    .toSorted((a, b) => a.at - b.at)
    .slice(-CONVERSATION_MAX);
}

export function feed(item: Routed) {
  state.batch.push(item);
  if (state.batchAt === 0) state.batchAt = Date.now();
}

function contextNotHandedYet(items: Routed[]) {
  const fresh = new Set(items.map((i) => i.at));
  const first = Math.min(...items.map((i) => i.at ?? Date.now()));
  const before: Said[] = [];
  const keys = new Set(items.map((i) => i.key));
  for (const key of keys) {
    const since = state.ctxSent[key] ?? first - FIRST_CONTEXT_MS;
    before.push(...(state.convo[key] ?? []).filter((x) => x.at > since && x.at < first && !fresh.has(x.at)).slice(-CONTEXT_MAX));
    state.ctxSent[key] = Math.max(state.ctxSent[key] ?? 0, ...items.filter((i) => i.key === key).map((i) => i.at ?? Date.now()));
  }
  return before;
}

const quoted = (text: string) => text.replaceAll("\n", "\n> ");
const contextLine = (x: Said) => `> **${x.mine === true ? "Isaac (him, on Slack/GitHub)" : x.who}:** ${quoted(shortened(x.text, 400))}`;

function contextPost(x: Said, first: Routed, source: string) {
  const ext = {
    source,
    name: x.mine === true ? "Isaac" : x.who,
    ...(x.user !== undefined && x.user !== "" && { user: x.user }),
    link: x.link ?? first.link,
    where: first.where,
    context: true,
    ...(x.mine === true && { own: true }),
  };
  return { text: x.raw ?? x.text, at: x.at, ext };
}

function newPost(i: Routed, source: string) {
  const ext = { source, name: i.who, ...(i.user !== undefined && i.user !== "" && { user: i.user }), link: i.link, where: i.where };
  return { text: i.raw ?? i.text, ...(i.at !== undefined && i.at !== 0 && { at: i.at }), ext };
}

function inboxPosts(first: Routed, items: Routed[], before: Said[]) {
  const source = first.source === "slack" ? "slack" : "github";
  return [...before.map((x) => contextPost(x, first, source)), ...items.map((i) => newPost(i, source))];
}

const PR_LINK = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi;
const feedKeysOf = (i: Routed) => [i.key, ...i.text.matchAll(PR_LINK).map((m) => `${m[1] ?? ""}#${m[2] ?? ""}`.toLowerCase())];
const isSingleTopicKey = (key: string) => !/^[CDG]\w+$/.test(key);

function liveThread(threads: FeedThread[], id: string | undefined): FeedThread | undefined {
  const thread = threads.find((x) => x.id === id);
  return thread?.mergedInto === undefined || thread.mergedInto === "" ? thread : liveThread(threads, thread.mergedInto);
}

function openFeedThreadOf(threads: FeedThread[], key: string) {
  const thread = liveThread(threads, state.feedThreads[key]);
  if (!thread) return;
  const isResolved = Boolean(thread.resolved);
  return isResolved ? undefined : thread.id;
}

function groupByOpenThread(threads: FeedThread[]) {
  const groups = new Map<string, { thread: string | undefined; items: Routed[] }>();
  for (const item of state.batch) {
    const thread = feedKeysOf(item)
      .filter(isSingleTopicKey)
      .map((key) => openFeedThreadOf(threads, key))
      .find((id) => id !== undefined && id !== "");
    const groupKey = thread ?? item.key;
    const group = groups.get(groupKey) ?? { thread, items: [] };
    group.items.push(item);
    groups.set(groupKey, group);
  }
  return groups;
}

function feedText(first: Routed, items: Routed[], context: Said[]) {
  const before = context.map(contextLine);
  const said = items.map((x) => `> ${quoted(x.text)}`).join("\n");
  const intro = before.length > 0 ? `Before it, in the same conversation (context, not new):\n${before.join("\n")}\n\nNew:\n` : "";
  return `${first.who} in ${first.where}:\n${intro}${said}\n${[...new Set(items.map((x) => x.link))].join("\n")}`;
}

type Message = { first: Routed; last: Routed; text: string; posts: unknown };

async function addToFeedThread(id: string, message: Message) {
  const { first, text, posts } = message;
  const res = await post(`/api/threads/${id}/messages`, { text, feed: true, posts });
  if (!res.ok) {
    log(`more into ${id} failed: ${await res.text()}`);
    return;
  }
  log(`T-${first.task}: more into ${id}`);
  return id;
}

async function openFeedThread(message: Message) {
  const { first, last, text, posts } = message;
  const res = await post("/api/threads", { title: `${first.who}: ${shortened(last.text, 70)}`, text, posts, feed: { source: first.source, who: first.who, link: first.link, task: first.task } });
  if (!res.ok) {
    log(`feed thread for T-${first.task} failed: ${await res.text()}`);
    return;
  }
  const made: unknown = await res.json();
  const madeId = dig(made, ["id"]);
  const id = typeof madeId === "string" ? madeId : undefined;
  log(`funnel: T-${first.task} as feed thread ${String(id)}`);
  return id;
}

async function sendGroup(thread: string | undefined, items: Routed[]) {
  const [first] = items;
  const last = items.at(-1);
  if (!first || !last) return;
  const context = contextNotHandedYet(items);
  const message = { first, last, posts: inboxPosts(first, items, context), text: feedText(first, items, context) };
  const id = thread === undefined ? await openFeedThread(message) : await addToFeedThread(thread, message);
  if (id === undefined) return;
  for (const x of items) for (const key of feedKeysOf(x)) state.feedThreads[key] = id;
}

const isFunnelRunning = async () => (await fetchSessions()).some((s) => s.sentry && s.name === "sentry:funnel" && s.running);

export async function flushBatch() {
  const tasks = await getTasks();
  state.batch = state.batch.filter((i) => isOpen(tasks.find((t) => t.id === i.task)));
  if (state.batch.length === 0) {
    state.batchAt = 0;
    return;
  }
  if (!(await isFunnelRunning())) {
    log("funnel isn't running; holding the batch");
    return;
  }
  const threads = await getThreads();
  for (const { thread, items } of groupByOpenThread(threads).values()) await sendGroup(thread, items);
  state.batch = [];
  state.batchAt = 0;
}
