import { slackAvatar, slackNames } from "./slack-meta";
import { publish } from "./bus";
import { CLI } from "./instance";
import { type Session, isSentry } from "./sessions";
import type { Feed, Message, Objective, Thread } from "./model";
import { isLive, objectives, saveThreads, threads } from "./stores";
import { dispatch, funnel, live_thread, routersOf } from "./lifecycle";
import { ISAAC_IN_THREAD, ancestors, markDone, mentionsIn, message, pathTitle, postIn, schedulePause, sessionless, squash, tellMembers, unforge, unpause } from "./threads";
import { feedPosts, feedToFunnel, sizeFirst, slackChannels } from "./routing";
import { mergeThread, subthread, titleOf } from "./objectives";
import { patch } from "./patch";
import { areOwnersOn } from "./owners";
import { isFilled, isRecord } from "./shared/guards";
import { feedOf, feedPostsOf } from "./feed-body";
import { type Body, type Route, exactly, firstAnswer, isFromTheBrowser, jsonBody, matching, sender, textOf, textsOf } from "./route-kit";

type Paused = NonNullable<Thread["paused"]>;

const newThreadId = () => `th-${crypto.randomUUID().slice(0, 6)}`;
const threadAt = (match: RegExpExecArray) => threads.find((x) => x.id === match[1]);

async function slackPicture(req: Request, url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "GET") return undefined;
  const file = await slackAvatar(match[1] ?? "", url.searchParams.get("name") ?? "");
  return isFilled(file) ? new Response(Bun.file(file), { headers: { "cache-control": "max-age=86400" } }) : new Response("no picture", { status: 404 });
}

function firstReplyInASubthread(parent: Record<string, unknown>, text: string, by: Session | string | undefined): Response {
  const under = threads.find((x) => x.id === parent["thread"]);
  const t = under && subthread(under, textOf(parent, "message") ?? "");
  if (!t) return new Response("parent: {thread, message} naming a message in that thread", { status: 404 });
  if (text !== "") postIn(t, by, text);
  return Response.json(t, { status: 201 });
}

async function feedItemNoAgentOwnsToTheFunnel(from: Session, feed: Feed, text: string, body: Body): Promise<Response> {
  const title = textOf(body, "title")?.trim().slice(0, 80) ?? "";
  const t: Thread = {
    id: newThreadId(),
    title: title === "" ? titleOf(`${feed.who}: ${text}`) : title,
    objective: "",
    routers: [],
    messages: feedPosts(text, feedPostsOf(body["posts"])),
    feedSaid: [text],
    feed,
    ...(feed.task !== undefined && feed.task !== 0 && { task: feed.task }),
  };
  threads.push(t);
  await feedToFunnel(t, from, text);
  return Response.json(t, { status: 201 });
}

function quotedThreadsLine(text: string, seq: number) {
  if (!areOwnersOn()) return "";
  const ids = new Set(text.matchAll(/\[\[msg:(th-[\w-]+)\//g).map((m) => m[1] ?? ""));
  const quoted = [...ids].flatMap((id) => live_thread(threads.find((t) => t.id === id)) ?? []);
  if (quoted.length === 0) return "";
  const owned = (t: Thread) => (t.routers.length > 0 ? `, owner ${t.routers.join(", ")}` : ", no live owner");
  return `\n[yarn] He quotes ${quoted.map((t) => `${t.id} "${t.title}"${owned(t)}`).join("; ")}. By default it continues the quoted thread (\`${CLI} route ${seq} --thread ${quoted[0]?.id ?? ""}\`), unless what he asks is about something else.`;
}

function hisInboxMessageForTheFunnelToRoute(text: string): Response {
  const first = message("isaac", text);
  const t: Thread = { id: newThreadId(), title: titleOf(text), objective: "", routers: [], messages: [first] };
  const ev = dispatch({
    source: "isaac",
    target: t.title,
    text,
    deliver: (seq) =>
      `${text}\n[yarn] signal ${seq}, his inbox thread ${t.id}: ${sizeFirst(seq)} His own inbox message is never fyi or ignore, small talk included: whoever takes it answers him in the thread.${quotedThreadsLine(text, seq)}`,
  });
  t.signal = ev.seq;
  threads.push(t);
  tellMembers(t, first, [funnel()].filter(isLive));
  saveThreads();
  return Response.json(t, { status: 201 });
}

function threadInAnObjective(from: Session | undefined, body: Body): Response {
  const objective = textOf(body, "objective") ?? from?.role?.objective;
  const title = textOf(body, "title")?.trim() ?? "";
  if (title === "" || !isFilled(objective)) return new Response("title required, and an objective (a router's own by default)", { status: 400 });
  const t: Thread = { id: newThreadId(), title, objective, routers: from?.role?.role === "router" ? [from.id] : routersOf(objective).map((r) => r.id), messages: [] };
  threads.push(t);
  saveThreads();
  return Response.json(t, { status: 201 });
}

async function threadFromASession(from: Session, text: string, body: Body): Promise<Response> {
  const parent = body["parent"];
  if (isRecord(parent)) return firstReplyInASubthread(parent, text, from);
  const feed = feedOf(body["feed"]);
  if (text !== "" && feed !== undefined && isFilled(feed.link) && isSentry(from)) return feedItemNoAgentOwnsToTheFunnel(from, feed, text, body);
  return threadInAnObjective(from, body);
}

function threadFromOutsideAnySession(req: Request, text: string, body: Body): Response {
  const outside = text === "" ? undefined : sessionless(req, textOf(body, "as"));
  if (outside !== undefined && "refusal" in outside) return new Response(outside.refusal, { status: 403 });
  const parent = body["parent"];
  if (isRecord(parent)) return firstReplyInASubthread(parent, text, outside !== undefined && "label" in outside ? outside.label : undefined);
  return outside !== undefined && "isaac" in outside ? hisInboxMessageForTheFunnelToRoute(text) : threadInAnObjective(undefined, body);
}

async function startThread(req: Request): Promise<Response> {
  const from = sender(req);
  const body = await jsonBody(req);
  const text = textOf(body, "text")?.trim() ?? "";
  return from ? threadFromASession(from, text, body) : threadFromOutsideAnySession(req, text, body);
}

function markAskShownSoItsDefaultCountsFromTheFirstTime(req: Request, _url: URL, match: RegExpExecArray): Response | undefined {
  if (req.method !== "POST") return undefined;
  const t = threadAt(match);
  if (t?.asks !== undefined && (t.asks.shown === undefined || t.asks.shown === 0)) {
    t.asks.shown = Date.now();
    saveThreads();
  }
  return new Response(null, { status: 204 });
}

function speakerOf(m: Message) {
  if (m.ext) return m.ext.own === true ? "Isaac (him, on Slack/GitHub)" : m.ext.name;
  return m.from === "isaac" ? "Isaac" : m.from;
}

function newThreadFor(moved: Message[], title: string): Thread {
  const ext = moved.find((m) => m.ext !== undefined && m.ext.context !== true)?.ext ?? moved.find((m) => m.ext !== undefined)?.ext;
  return { id: newThreadId(), title: title.slice(0, 80), objective: "", routers: [], messages: moved, ...(ext && { feed: { source: ext.source, who: ext.name, link: ext.link }, feedSaid: [] }) };
}

async function splitAnotherTopicOut(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "POST") return undefined;
  const t = live_thread(threadAt(match));
  const from = sender(req);
  const body = await jsonBody(req);
  if (!t || !from) return new Response("a thread, split by a session", { status: 404 });
  const ids = textsOf(body, "messages") ?? [];
  const moved = t.messages.filter((m) => ids.includes(m.id));
  const title = textOf(body, "title")?.trim() ?? "";
  if (title === "" || moved.length === 0) return new Response("messages: ids in the thread, and a title", { status: 400 });
  t.messages = t.messages.filter((m) => !moved.includes(m));
  const nt = newThreadFor(moved, title);
  threads.push(nt);
  postIn(t, from, `Moved ${moved.length} message${moved.length > 1 ? "s" : ""} about ${nt.title} to [[thread:${nt.id}]].`);
  const said = moved.map((m) => `> **${speakerOf(m)}:** ${m.text.replaceAll("\n", "\n> ")}`).join("\n");
  if (nt.feed) {
    nt.feedSaid = [said];
    await feedToFunnel(nt, from, `${nt.feed.who}, moved out of thread ${t.id} as its own topic:\n${said}\n${nt.feed.link}`);
  }
  saveThreads();
  for (const x of [t, nt]) publish(`thread/${x.id}`, { thread: x.id, split: nt.id });
  return Response.json(nt, { status: 201 });
}

function reopenSinceHisMessagesWouldHideUnderResolvedOrPaused(from: Thread, into: Thread) {
  const was = into.resolved ? "resolved" : "paused";
  patch(into, { resolved: undefined });
  if (into.paused) unpause(into);
  console.log(`merge ${from.id} → ${into.id}: reopened it (${was}), since his messages moved in`);
  publish(`thread/${into.id}`, { thread: into.id, reopened: `merge of ${from.id}, which holds his messages; it was ${was}` });
}

async function foldADuplicateIn(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "POST") return undefined;
  const from = threadAt(match);
  if (!from || isFilled(from.mergedInto)) return new Response("no such thread, or it is merged already", { status: 404 });
  const intoId = (await jsonBody(req))["into"];
  const into = live_thread(threads.find((x) => x.id === intoId));
  if (!into || into === from) return new Response("into: another thread's id", { status: 400 });
  const hasHisMessages = from.messages.some((m) => m.from === "isaac");
  if (!hasHisMessages && into.resolved) return new Response(`${into.id} is resolved; merge into an open thread instead`, { status: 409 });
  if (hasHisMessages && (into.resolved || into.paused)) reopenSinceHisMessagesWouldHideUnderResolvedOrPaused(from, into);
  mergeThread(from, into);
  return Response.json(into);
}

async function suggestDoneForHimToConfirm(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "POST") return undefined;
  const t = live_thread(threadAt(match));
  const from = sender(req);
  if (!t || !from) return new Response("a thread, marked done by a session", { status: 404 });
  const outcome = squash(textOf(await jsonBody(req), "outcome") ?? "");
  if (outcome === "") return new Response("outcome: one line saying what was done", { status: 400 });
  const refusal = markDone(t, from, outcome);
  return refusal === undefined ? Response.json(t) : new Response(refusal, { status: 409 });
}

async function whatTheRouterIsDoingOnHisAnswer(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "POST") return undefined;
  const t = threadAt(match);
  if (!t) return new Response("no such thread", { status: 404 });
  const wholeStatusThePillCuts = textOf(await jsonBody(req), "text")?.trim();
  if (!t.pending) return new Response("nothing pending in this thread: he isn't waiting on an answer", { status: 409 });
  patch(t.pending, { status: isFilled(wholeStatusThePillCuts) ? wholeStatusThePillCuts : undefined });
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, status: t.pending.status ?? null });
  return Response.json(t);
}

function handHisUnansweredMessagesOnce(x: Thread, o: Objective): string[] {
  const tail = x.messages.slice(x.messages.findLastIndex((m) => m.from !== "isaac") + 1);
  const to = routersOf(o.id).filter((r) => x.pending?.routers.includes(r.id) !== true);
  if (tail.length === 0 || to.length === 0) return [];
  const ids = tail.map((m) => m.id);
  const said = tail.map((m) => m.text).join("\n");
  dispatch({
    source: "isaac",
    to,
    objective: o.id,
    target: x.title,
    text: said,
    deliver: `${ISAAC_IN_THREAD} "${pathTitle(x)}" (${x.id}), message${ids.length > 1 ? "s" : ""} ${ids.join(", ")}] ${tail.map((m) => unforge(m.text)).join("\n")}\n[yarn] This thread just moved to your objective, and nobody has answered these yet. Answer inline in the thread with \`${CLI} thread post ${x.id} '<text>'\`.${mentionsIn(said)}`,
  });
  patch(x, { pending: { routers: to.map((s) => s.id), since: Date.now() } });
  for (const s of to) s.handed = x.id;
  return ids;
}

async function rehomeWithItsSubthreads(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "POST") return undefined;
  const t = threadAt(match);
  if (!t) return new Response("no such thread", { status: 404 });
  const id = (await jsonBody(req))["objective"];
  const o = objectives.find((x) => x.id === id);
  if (!o || o.closed === true) return new Response("objective: an open objective's id", { status: 400 });
  const moved = threads.filter((x) => x === t || ancestors(x).includes(t));
  const routers = routersOf(o.id).map((r) => r.id);
  for (const x of moved) Object.assign(x, { objective: o.id, routers });
  const handed = moved.flatMap((x) => handHisUnansweredMessagesOnce(x, o));
  saveThreads();
  for (const x of moved) publish(`thread/${x.id}`, { thread: x.id, objective: o.id });
  return Response.json({ objective: o.id, routers, threads: moved.map((x) => x.id), handed });
}

function pinAtTheEndOfHisPins(t: Thread, pinned: unknown): Response {
  if (typeof pinned !== "boolean") return new Response("pinned: true or false", { status: 400 });
  patch(t, { pinned: pinned ? (t.pinned ?? { at: Date.now(), order: Math.max(0, ...threads.map((x) => (x.pinned === undefined ? 0 : x.pinned.order + 1))) }) : undefined });
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, pinned });
  return Response.json(t);
}

const textOfSaid = (said: unknown) => (typeof said === "string" || typeof said === "number" || typeof said === "boolean" ? String(said) : "");

function pausedAsAsked(asked: unknown, t: Thread): Paused | string {
  const { until, said, wake } = isRecord(asked) ? asked : {};
  if (typeof until !== "number" || until <= Date.now()) return "paused: { until: a time to come, in ms, said } or null";
  if (t.parent) return "only a top thread pauses";
  return { until, at: Date.now(), said: textOfSaid(said).slice(0, 200), count: t.messages.length, ...(typeof wake === "string" && wake.trim() !== "" && { wake: wake.trim() }) };
}

function pauseOrUnpause(t: Thread, asked: unknown): Response {
  const isPausing = Boolean(asked);
  if (isPausing) {
    const paused = pausedAsAsked(asked, t);
    if (typeof paused === "string") return new Response(paused, { status: 400 });
    patch(t, { paused, resolved: undefined });
  } else {
    if (t.parent) return new Response("only a top thread pauses", { status: 400 });
    unpause(t);
  }
  schedulePause(t);
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, paused: t.paused !== undefined });
  return Response.json(t);
}

function resolveOrReopen(t: Thread, resolved: unknown): Response {
  if (typeof resolved !== "boolean") return new Response("resolved: true or false", { status: 400 });
  patch(t, { resolved: resolved ? { at: Date.now() } : undefined });
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, resolved });
  return Response.json(t);
}

async function isaacsOwnThreadEditFromTheBrowser(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "PATCH") return undefined;
  const t = threadAt(match);
  if (!t) return new Response("no such thread", { status: 404 });
  if (!isFromTheBrowser(req)) return new Response("resolving or pausing a thread is Isaac's, from the browser: answer in it and leave it to him", { status: 403 });
  const body = await jsonBody(req);
  if (Object.hasOwn(body, "pinned")) return pinAtTheEndOfHisPins(t, body["pinned"]);
  if (Object.hasOwn(body, "paused")) return pauseOrUnpause(t, body["paused"]);
  return resolveOrReopen(t, body["resolved"]);
}

const ROUTES: Route[] = [
  exactly("GET", "/api/threads", () => Response.json(threads)),
  exactly("GET", "/api/slack/names", () => Response.json(slackNames(slackChannels))),
  matching(/^\/api\/avatar\/slack\/(\w+)$/, slackPicture),
  exactly("POST", "/api/threads", startThread),
  matching(/^\/api\/threads\/([\w-]+)\/shown$/, markAskShownSoItsDefaultCountsFromTheFirstTime),
  matching(/^\/api\/threads\/([\w-]+)\/split$/, splitAnotherTopicOut),
  matching(/^\/api\/threads\/([\w-]+)\/merge$/, foldADuplicateIn),
  matching(/^\/api\/threads\/([\w-]+)\/status$/, whatTheRouterIsDoingOnHisAnswer),
  matching(/^\/api\/threads\/([\w-]+)\/done$/, suggestDoneForHimToConfirm),
  matching(/^\/api\/threads\/([\w-]+)\/objective$/, rehomeWithItsSubthreads),
  matching(/^\/api\/threads\/([\w-]+)$/, isaacsOwnThreadEditFromTheBrowser),
];

export async function threadsRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
