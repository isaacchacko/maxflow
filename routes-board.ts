import { type BoardPost, boardUrl, handOver, postAsIsaac, postedBy, readBoard, replyOnBoard } from "./board-bus";
import { isRecord } from "./shared/guards";
import { worldClients } from "./world";
import { isSentry } from "./sessions";
import { type Route, exactly, firstAnswer, jsonBody, sender, textOf } from "./route-kit";
import { isaacRefusal } from "./isaac-auth";

const orUnknown = (value = "?") => value;

async function handOverFromTheSentry(req: Request): Promise<Response> {
  const from = sender(req);
  if (!from || !isSentry(from)) return new Response("only the board-bus sentry hands board messages over", { status: 403 });
  const body = await jsonBody(req);
  const [id, channel, text, handle, device, re] = ["id", "channel", "text", "handle", "device", "re"].map((key) => textOf(body, key));
  if (id === undefined || channel === undefined || text === undefined) return new Response("id, channel and text required", { status: 400 });
  const post: BoardPost = { id, channel, text, handle: orUnknown(handle), device: orUnknown(device), ...(re !== undefined && { re }) };
  return Response.json({ outcome: handOver(post) });
}

async function replyAsTheCaller(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const [re, text] = [textOf(body, "re"), textOf(body, "text")?.trim()];
  if (re === undefined || text === undefined || text === "") return new Response("re and text required", { status: 400 });
  const carried = await replyOnBoard(sender(req), re, text);
  return carried.via === "board" ? Response.json(carried) : new Response(carried.error, { status: 502 });
}

const CHANNEL_PAGES = 20;
const THREADS_SHOWN = "60";
const REPLIES_SHOWN = "200";
const LIVE_WAIT_S = 25;
const LIVE_BACKOFF_MS = 15_000;

const answered = (read: { body: unknown } | { error: string }) => ("error" in read ? new Response(read.error, { status: 502 }) : Response.json(read.body));

async function channels(): Promise<Response> {
  const all: unknown[] = [];
  let after = "";
  for (let page = 0; page < CHANNEL_PAGES; page += 1) {
    const read = await readBoard(`/channels?limit=500${after === "" ? "" : `&after=${encodeURIComponent(after)}`}`);
    if ("error" in read) return answered(read);
    const listed: unknown = isRecord(read.body) ? read.body["channels"] : undefined;
    if (Array.isArray(listed)) for (const channel of listed as unknown[]) all.push(channel);
    const next = isRecord(read.body) ? read.body["next"] : null;
    if (typeof next !== "string" || next === "") break;
    after = next;
  }
  return Response.json({ channels: all });
}

const idOf = (m: unknown) => (isRecord(m) && typeof m["id"] === "string" ? m["id"] : undefined);
const idsIn = (messages: unknown[]) => messages.map(idOf).filter((id) => id !== undefined);
const rootsOf = (listed: unknown[]) => listed.map((x) => (isRecord(x) ? x["message"] : undefined));

async function threads(url: URL): Promise<Response> {
  const query = new URLSearchParams({ limit: THREADS_SHOWN });
  for (const [key, as] of [["channel", "channel"], ["q", "text"], ["older", "before"]] as const) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") query.set(as, value);
  }
  const read = await readBoard(`/threads?${query.toString()}`);
  if ("error" in read) return answered(read);
  const listed: unknown = isRecord(read.body) ? read.body["threads"] : undefined;
  const roots = rootsOf(Array.isArray(listed) ? (listed as unknown[]) : []);
  const yarn = postedBy(idsIn(roots));
  return Response.json({ ...(isRecord(read.body) && read.body), yarn });
}

async function thread(url: URL): Promise<Response> {
  const id = url.searchParams.get("id") ?? "";
  if (!/^[\w-]+$/.test(id)) return new Response("id required", { status: 400 });
  const read = await readBoard(`/messages/${id}?limit=${REPLIES_SHOWN}`);
  if ("error" in read || !isRecord(read.body)) return answered(read);
  const replies: unknown = read.body["replies"];
  const messages: unknown[] = [read.body["message"]];
  if (Array.isArray(replies)) for (const reply of replies as unknown[]) messages.push(reply);
  return Response.json({ ...read.body, yarn: postedBy(idsIn(messages)) });
}

async function postFromHisBrowser(req: Request): Promise<Response> {
  const refused = isaacRefusal(req, "posts on the board as himself");
  if (refused) return refused;
  const body = await jsonBody(req);
  const [channel, re, text] = [textOf(body, "channel"), textOf(body, "re"), textOf(body, "text")?.trim()];
  if (channel === undefined || text === undefined || text === "") return new Response("channel and text required", { status: 400 });
  const carried = await postAsIsaac(re === undefined ? { channel } : { re, channel }, text);
  return carried.via === "board" ? Response.json(carried) : new Response(carried.error, { status: 502 });
}

function sayBoardChanged(event: unknown) {
  const message = isRecord(event) && isRecord(event["message"]) ? event["message"] : {};
  const said = JSON.stringify({ type: "board", channel: message["channel"] ?? null, thread: message["thread"] ?? null });
  for (const ws of worldClients) ws.sendText(said);
}

async function followTheBoardForTheTab() {
  let cursor = "";
  for (;;) {
    if (boardUrl() === undefined) {
      await Bun.sleep(LIVE_BACKOFF_MS);
      continue;
    }
    const read = await readBoard(cursor === "" ? "/events?last=1" : `/events?after=${encodeURIComponent(cursor)}&wait=${String(LIVE_WAIT_S)}`, (LIVE_WAIT_S + 10) * 1000);
    if ("error" in read || !isRecord(read.body)) {
      await Bun.sleep(LIVE_BACKOFF_MS);
      continue;
    }
    const events = Array.isArray(read.body["events"]) ? read.body["events"] : [];
    if (cursor !== "") for (const event of events) sayBoardChanged(event);
    cursor = typeof read.body["cursor"] === "string" ? read.body["cursor"] : cursor;
  }
}
void followTheBoardForTheTab();

const ROUTES: Route[] = [
  exactly("POST", "/api/board-bus/deliver", handOverFromTheSentry),
  exactly("POST", "/api/board-bus/reply", replyAsTheCaller),
  exactly("GET", "/api/board/channels", channels),
  exactly("GET", "/api/board/threads", async (_req, url) => threads(url)),
  exactly("GET", "/api/board/thread", async (_req, url) => thread(url)),
  exactly("POST", "/api/board/post", postFromHisBrowser),
];

export const boardRoute = async (req: Request, url: URL, path: string) => firstAnswer(ROUTES, req, url, path);
