import { type BoardPost, handOver, replyOnBoard } from "./board-bus";
import { isSentry } from "./sessions";
import { type Route, exactly, firstAnswer, jsonBody, sender, textOf } from "./route-kit";

async function handOverFromTheSentry(req: Request): Promise<Response> {
  const from = sender(req);
  if (!from || !isSentry(from)) return new Response("only the board-bus sentry hands board messages over", { status: 403 });
  const body = await jsonBody(req);
  const [id, channel, text, handle, device, re] = ["id", "channel", "text", "handle", "device", "re"].map((key) => textOf(body, key));
  if (id === undefined || channel === undefined || text === undefined) return new Response("id, channel and text required", { status: 400 });
  const post: BoardPost = { id, channel, text, handle: handle ?? "?", device: device ?? "?", ...(re !== undefined && { re }) };
  return Response.json({ outcome: handOver(post) });
}

async function replyAsTheCaller(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const [re, text] = [textOf(body, "re"), textOf(body, "text")?.trim()];
  if (re === undefined || text === undefined || text === "") return new Response("re and text required", { status: 400 });
  const carried = await replyOnBoard(sender(req), re, text);
  return carried.via === "board" ? Response.json(carried) : new Response(carried.error, { status: 502 });
}

const ROUTES: Route[] = [exactly("POST", "/api/board-bus/deliver", handOverFromTheSentry), exactly("POST", "/api/board-bus/reply", replyAsTheCaller)];

export const boardRoute = async (req: Request, url: URL, path: string) => firstAnswer(ROUTES, req, url, path);
