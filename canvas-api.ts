import { addNode, CanvasConflict, createCanvas, type Edit, editNode, linkNode, markTyping, onCanvasChange, readCanvas, removeNode } from "./canvas";
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

const STRING_FIELDS = ["text", "base", "find", "replace", "append", "color"] as const;
const NUMBER_FIELDS = ["x", "y", "width", "height"] as const;

function boxOf(body: Record<string, unknown>): Edit {
  const strings = STRING_FIELDS.flatMap((key) => (typeof body[key] === "string" ? [[key, body[key]]] : []));
  const numbers = NUMBER_FIELDS.flatMap((key) => (typeof body[key] === "number" ? [[key, body[key]]] : []));
  return Object.fromEntries([...strings, ...numbers]) as Edit;
}

type Call = { req: Request; path: string; rest: string | undefined; author: string };

async function boxAction({ req, path, author }: Call, id: string, verb: string | undefined) {
  const body = req.method === "DELETE" ? {} : await bodyOf(req);
  if (verb === "typing" && req.method === "POST") {
    markTyping(path, id);
    return { typing: id };
  }
  if (verb === "link" && req.method === "POST") return linkNode(path, id, { text: stringOr(body["text"]), to: stringOr(body["to"]), near: typeof body["at"] === "number" ? body["at"] : 0 }, author);
  if (verb !== undefined) return;
  if (req.method === "PATCH") return editNode(path, id, boxOf(body), author);
  if (req.method !== "DELETE") return;
  return removeNode(path, id);
}

async function canvasAction(call: Call) {
  const { req, path, rest, author } = call;
  if (rest === undefined && req.method === "GET") return readCanvas(path);
  if (rest === undefined && req.method === "POST") return createCanvas(path);
  if (rest === "nodes" && req.method === "POST") return addNode(path, boxOf(await bodyOf(req)), author);
  const box = /^nodes\/([\w-]+)(?:\/(\w+))?$/.exec(rest ?? "");
  if (box?.[1] === undefined) return;
  return boxAction(call, box[1], box[2]);
}

function failed(error: unknown) {
  if (error instanceof CanvasConflict) return Response.json(error.node, { status: 409 });
  const message = error instanceof Error ? error.message : String(error);
  return new Response(message, { status: message.startsWith("no ") ? 404 : 400 });
}

const USAGE = "GET or POST /api/canvas/<path>; POST <path>/nodes {text,x,y,width?,height?}; PATCH <path>/nodes/<id> {text?,base?,find?,replace?,append?,x?,y?,width?,height?}; POST <path>/nodes/<id>/typing; DELETE <path>/nodes/<id>; POST <path>/nodes/<id>/link {text,to,at?}";

export async function canvasRoute(req: Request, url: URL): Promise<Response | undefined> {
  const m = /^\/api\/canvas\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);
  if (m?.[1] === undefined) return;
  const author = sessions.get(req.headers.get("x-maxflow-from") ?? "")?.id ?? "isaac";
  try {
    const done = await canvasAction({ req, path: decodeURIComponent(m[1]), rest: m[2], author });
    if (done === undefined) return new Response(USAGE, { status: 400 });
    const isNew = req.method === "POST" && m[2]?.includes("/") !== true;
    return Response.json(done, { status: isNew ? 201 : 200 });
  } catch (error) {
    return failed(error);
  }
}
