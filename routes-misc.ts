import { latestSeq, publish, query } from "./bus";
import { findChat, listChats } from "./chats";
import { CLI } from "./instance";
import { enforce } from "./restrictions-enforce";
import { type Session, isSentry, sessions } from "./sessions";
import type { Block, Thread } from "./model";
import { names, saveThreads, threads } from "./stores";
import { createSession, live_thread } from "./lifecycle";
import { ask, enforcing, postIn, sessionless } from "./threads";
import { describe } from "./world-session";
import { externalSignal, feedMore } from "./routing";
import { doesPointAtItself, relayRefusal } from "./objectives";
import { onEvent } from "./events";
import { reviewBoard, reviewQueueOfEveryOpenPr, touchFrom } from "./sentry-files";
import { favicons, fetchFavicon } from "./favicons";
import { SENTRIES, restartSentry } from "./sentry-commands";
import { pageOf } from "./pages";
import { isFilled, isRecord } from "./shared/guards";
import { callOf } from "./restriction-draft";
import { feedPostsOf } from "./feed-body";
import { type Body, type Route, exactly, firstAnswer, flagOf, isFromTheBrowser, jsonBody, matching, sender, textOf } from "./route-kit";

async function reorderPinsAsHeDraggedThem(req: Request): Promise<Response> {
  if (!isFromTheBrowser(req)) return new Response("pins are Isaac's, from the browser", { status: 403 });
  const asked = (await jsonBody(req))["order"];
  const order: unknown[] | undefined = Array.isArray(asked) ? asked : undefined;
  if (order === undefined) return new Response("order: the pinned thread ids, first to last", { status: 400 });
  for (const [i, id] of order.entries()) {
    const t = threads.find((x) => x.id === id);
    if (t?.pinned) t.pinned.order = i;
  }
  saveThreads();
  publish("pins", { order });
  return new Response(null, { status: 204 });
}

const trimmedTextOf = (body: Body) => textOf(body, "text")?.trim() ?? "";
const nudgeOf = (body: Body) => (body["nudge"] === "subthread" ? "subthread" : undefined);

async function postFromASession(t: Thread, from: Session, asked: string, body: Body): Promise<Response> {
  const text = trimmedTextOf(body);
  if (flagOf(body, "feed") === true && isSentry(from)) {
    await feedMore(t, from, text, feedPostsOf(body["posts"]));
    return Response.json(t, { status: 201 });
  }
  if (doesPointAtItself(text, t))
    return new Response(`${asked === t.id ? `This is ${t.id}` : `${asked} was merged into ${t.id}, so this would land in ${t.id}`}, and a pointer to it there points at itself. Post only what is new for him, or nothing.`, { status: 409 });
  const relay = relayRefusal(t, from, text);
  if (relay !== undefined) return new Response(relay, { status: 409 });
  postIn(t, from, text, nudgeOf(body));
  return Response.json(t, { status: 201 });
}

async function postInThread(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "POST") return undefined;
  const [, asked = ""] = match;
  const t = live_thread(threads.find((x) => x.id === asked));
  if (!t) return new Response("no such thread", { status: 404 });
  const body = await jsonBody(req);
  const text = trimmedTextOf(body);
  if (text === "") return new Response("text required", { status: 400 });
  const from = sender(req);
  if (from) return postFromASession(t, from, asked, body);
  const outside = sessionless(req, textOf(body, "as"));
  if ("refusal" in outside) return new Response(outside.refusal, { status: 403 });
  postIn(t, "label" in outside ? outside.label : undefined, text, nudgeOf(body));
  return Response.json(t, { status: 201 });
}

function blockOf(value: unknown): Block | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, w, h } = value;
  if (typeof id !== "string" || typeof kind !== "string" || typeof w !== "number" || typeof h !== "number" || id === "" || kind === "" || w === 0 || h === 0) return undefined;
  return { ...value, id, kind, w, h };
}

async function editACardOnAnObjectiveOrTaskPage(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const ref = textOf(body, "ref") ?? "";
  const p = pageOf(ref);
  if (!p) return new Response("ref must be objective/<id> or task/<id>", { status: 404 });
  const asked = body["block"];
  if (req.method === "DELETE") p.page.splice(0, p.page.length, ...p.page.filter((b) => b.id !== body["id"]));
  else {
    const card = blockOf(asked);
    if (!card) return new Response("block needs id, kind, w and h", { status: 400 });
    const i = p.page.findIndex((x) => x.id === card.id);
    if (i === -1) p.page.push(card);
    else p.page[i] = card;
  }
  p.save();
  publish(`page/${ref}`, { ref, block: (isRecord(asked) ? asked["id"] : undefined) ?? body["id"] });
  return Response.json(p.page);
}

function chatSessions() {
  const open = new Map<string, string>();
  for (const s of sessions.values()) if (isFilled(s.chatId) && s.exitCode === null) open.set(s.chatId, s.id);
  return open;
}

async function listChatsMatching(_req: Request, url: URL): Promise<Response> {
  const q = url.searchParams.get("q")?.toLowerCase() ?? "";
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const open = chatSessions();
  const chats = (await listChats())
    .filter((c) => q === "" || `${c.title} ${c.prompt} ${c.cwd} ${c.id}`.toLowerCase().includes(q))
    .slice(0, limit)
    .map((c) => ({ ...c, session: open.get(c.id) ?? null }));
  return Response.json(chats);
}

async function resumeChat(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "POST") return undefined;
  const [, id = ""] = match;
  const body = await jsonBody(req);
  const open = sessions.values().find((s) => s.chatId === id && s.exitCode === null);
  if (open) return Response.json(describe(open));
  const chat = await findChat(id);
  if (!chat) return new Response("no such chat", { status: 404 });
  if (chat.live && flagOf(body, "force") !== true) return Response.json({ error: "live", chat }, { status: 409 });
  const cmd = ["claude", "--resume", chat.id, ...(flagOf(body, "bypass") === true ? ["--permission-mode", "bypassPermissions"] : [])];
  const resumed = createSession(chat.title.slice(0, 40), cmd, chat.cwd, { chatId: chat.id });
  return Response.json(describe(resumed), { status: 201 });
}

async function restartRunningSentry(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const s = sessions.values().find((o) => o.sentry === true && o.name === body["name"] && o.exitCode === null);
  if (!s || !Object.hasOwn(SENTRIES, s.name)) return new Response(`no running sentry ${String(body["name"])}`, { status: 404 });
  const r = restartSentry(s, flagOf(body, "fresh") === true);
  return r.ok ? Response.json(r) : new Response(`respawning ${s.name} failed; see the log`, { status: 500 });
}

async function eventsAfter(_req: Request, url: URL): Promise<Response> {
  const p = url.searchParams;
  const after = p.get("after") === "now" ? latestSeq() : Number(p.get("after") ?? 0);
  const waitMs = Math.min(Number(p.get("wait") ?? 0), 3_600_000);
  const events = await query(p.get("topic") ?? "**", after, waitMs);
  return Response.json(events, { headers: { "x-maxflow-seq": String(after) } });
}

async function publishEvent(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const topic = textOf(body, "topic");
  if (!isFilled(topic)) return new Response("topic required", { status: 400 });
  const ev = publish(topic, body["data"] ?? null);
  onEvent(topic, body["data"], sender(req));
  externalSignal(ev);
  return Response.json(ev, { status: 201 });
}

async function favicon(_req: Request, url: URL): Promise<Response> {
  const host = url.searchParams.get("host") ?? "";
  if (!/^[\w.-]+(:\d+)?$/.test(host)) return new Response("bad host", { status: 400 });
  if (!favicons.has(host)) favicons.set(host, fetchFavicon(host));
  return (await favicons.get(host))?.clone() ?? new Response("no favicon", { status: 404 });
}

async function drawAnAgentTouchingTheSentryItUsesThroughTheCli(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const to = sessions.values().find((o) => isSentry(o) && o.name === `sentry:${String(body["sentry"])}` && o.exitCode === null);
  if (to) touchFrom(req, to, body["kind"] === "write" ? "write" : "read");
  return new Response(null, { status: 204 });
}

async function verdictForTheRestrictionsHookWithTheSessionsObjective(req: Request): Promise<Response> {
  const { objective: _asked, ...call } = callOf(await jsonBody(req));
  const s = sender(req);
  if (!s || call.tool === "") return Response.json({ decision: "allow" });
  const objective = s.role?.objective;
  return Response.json(enforce({ session: s.id, ...call, ...(objective !== undefined && { objective }) }, enforcing));
}

function sameAskRefusal(same: Thread): Response {
  const by = same.asks?.session ?? "";
  return new Response(
    `${same.id} already asks him something close, from ${sessions.get(by)?.name ?? names[by] ?? by}: "${same.title}". If it's the same ask, add to it with \`${CLI} ask --re ${same.id} '<text>'\` and wait on thread:${same.id}; if it really is different, ask again with --new.`,
    { status: 409 },
  );
}

async function openAThreadWaitingOnHim(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const s = sender(req);
  if (!s) return new Response("ask from inside a maxflow session ($MAXFLOW_SESSION)", { status: 400 });
  const text = textOf(body, "text")?.trim() ?? "";
  if (text === "") return new Response("text required", { status: 400 });
  const [re, dflt] = [textOf(body, "re")?.trim(), textOf(body, "default")?.trim()];
  const t = ask(s, text, { re: isFilled(re) ? re : undefined, dflt: isFilled(dflt) ? dflt : undefined, isFresh: flagOf(body, "new") });
  if (t !== null && "same" in t) return sameAskRefusal(t.same);
  return t ? Response.json(t, { status: 201 }) : new Response(`no thread ${String(body["re"])}`, { status: 404 });
}

const ROUTES: Route[] = [
  exactly("PATCH", "/api/pins", reorderPinsAsHeDraggedThem),
  matching(/^\/api\/threads\/([\w-]+)\/messages$/, postInThread),
  exactly("POST", "/api/pages", editACardOnAnObjectiveOrTaskPage),
  exactly("DELETE", "/api/pages", editACardOnAnObjectiveOrTaskPage),
  exactly("GET", "/api/chats", listChatsMatching),
  matching(/^\/api\/chats\/([0-9a-f-]{36})\/resume$/, resumeChat),
  exactly("POST", "/api/sentries/restart", restartRunningSentry),
  exactly("GET", "/api/events", eventsAfter),
  exactly("POST", "/api/events", publishEvent),
  exactly("GET", "/api/favicon", favicon),
  exactly("GET", "/api/review", () => Response.json({ board: reviewBoard(), queue: reviewQueueOfEveryOpenPr() })),
  exactly("POST", "/api/touch", drawAnAgentTouchingTheSentryItUsesThroughTheCli),
  exactly("POST", "/api/restrictions/enforce", verdictForTheRestrictionsHookWithTheSessionsObjective),
  exactly("POST", "/api/asks", openAThreadWaitingOnHim),
];

export async function miscRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
