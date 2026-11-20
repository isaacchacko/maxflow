import { callerOf } from "./shared/legacy-maxflow";
import { addNode, CanvasConflict, createCanvas, type Edit, editNode, linkNode, markTyping, onCanvasChange, proposeText, readCanvas, removeNode, settleProposal } from "./canvas";
import { agentStatus, chargeAgent, markOpen, wakeFor } from "./canvas-agent";
import { sessions } from "./sessions";
import { isRecord, stringOr } from "./shared/guards";
import { worldClients } from "./world";
import { isCanvasClaimed } from "./cursors";

onCanvasChange((path, rev) => {
  const msg = JSON.stringify({ type: "canvas", path, rev, ...(isCanvasClaimed(path) && { claimed: true }) });
  for (const ws of worldClients) ws.sendText(msg);
});

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

const STRING_FIELDS = ["text", "base", "find", "replace", "append", "color", "near"] as const;
const NUMBER_FIELDS = ["x", "y", "width", "height"] as const;

function boxOf(body: Record<string, unknown>): Edit & { near?: string } {
  const strings = STRING_FIELDS.flatMap((key) => (typeof body[key] === "string" ? [[key, body[key]]] : []));
  const numbers = NUMBER_FIELDS.flatMap((key) => (typeof body[key] === "number" ? [[key, body[key]]] : []));
  return Object.fromEntries([...strings, ...numbers]) as Edit & { near?: string };
}

type Call = { req: Request; path: string; rest: string | undefined; author: string };

function boxPost({ path, author }: Call, id: string, verb: string, body: Record<string, unknown>) {
  if (verb === "typing") {
    markTyping(path, id);
    return { typing: id };
  }
  if (verb === "link") return linkNode(path, id, { text: stringOr(body["text"]), to: stringOr(body["to"]), near: typeof body["at"] === "number" ? body["at"] : 0 }, author);
  if (verb === "accept" || verb === "reject") return settleProposal(path, id, verb === "accept", author);
  if (verb !== "propose") return;
  chargeAgent(path, author, "proposal");
  return proposeText(path, id, stringOr(body["text"]), author);
}

async function boxAction(call: Call, id: string, verb: string | undefined) {
  const { req, path, author } = call;
  const body = req.method === "DELETE" ? {} : await bodyOf(req);
  if (verb !== undefined) return req.method === "POST" ? boxPost(call, id, verb, body) : undefined;
  if (req.method === "PATCH") return editNode(path, id, boxOf(body), author);
  if (req.method !== "DELETE") return;
  return removeNode(path, id, author);
}

function canvasPost({ path, author }: Call, verb: string | undefined) {
  if (verb === undefined) return createCanvas(path);
  if (verb === "ask" && author === "isaac") return { asked: wakeFor(path, "asked") };
}

function shown({ path, author }: Call) {
  if (author === "isaac") markOpen(path);
  return { ...readCanvas(path), agent: agentStatus(path) ?? null };
}

async function canvasAction(call: Call) {
  const { req, path, rest, author } = call;
  if (rest === undefined && req.method === "GET") return shown(call);
  if (req.method === "POST" && (rest === undefined || rest === "ask")) return canvasPost(call, rest);
  if (rest === "nodes" && req.method === "POST") {
    chargeAgent(path, author, "box");
    return addNode(path, boxOf(await bodyOf(req)), author);
  }
  const box = /^nodes\/([\w-]+)(?:\/(\w+))?$/.exec(rest ?? "");
  if (box?.[1] === undefined) return;
  return boxAction(call, box[1], box[2]);
}

function failed(error: unknown) {
  if (error instanceof CanvasConflict) return Response.json(error.node, { status: 409 });
  const message = error instanceof Error ? error.message : String(error);
  return new Response(message, { status: message.startsWith("no ") ? 404 : 400 });
}

const USAGE =
  "GET or POST /api/canvas/<path>; POST <path>/ask; POST <path>/nodes {text,x?,y?,near?,width?,height?}; PATCH <path>/nodes/<id> {text?,base?,find?,replace?,append?,x?,y?,width?,height?}; DELETE <path>/nodes/<id>; POST <path>/nodes/<id>/typing | link {text,to,at?} | propose {text} | accept | reject";

const isCreating = (req: Request, rest: string | undefined) => req.method === "POST" && (rest === undefined || rest === "nodes");

export async function canvasRoute(req: Request, url: URL): Promise<Response | undefined> {
  const m = /^\/api\/canvas\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);
  if (m?.[1] === undefined) return;
  const author = sessions.get(callerOf(req))?.id ?? "isaac";
  try {
    const done = await canvasAction({ req, path: decodeURIComponent(m[1]), rest: m[2], author });
    if (done === undefined) return new Response(USAGE, { status: 400 });
    return Response.json(done, { status: isCreating(req, m[2]) ? 201 : 200 });
  } catch (error) {
    return failed(error);
  }
}
