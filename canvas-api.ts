import { addNode, CanvasConflict, createCanvas, type Edit, editNode, linkNode, markTyping, onCanvasChange, readCanvas, removeNode } from "./canvas";
import { sessions } from "./sessions";
import { isRecord, stringOr } from "./shared/guards";
import { worldClients } from "./world";

onCanvasChange((path, rev) => {
  const msg = JSON.stringify({ type: "canvas", path, rev });
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

async function nodeAction(req: Request, path: string, id: string, rest: string | undefined, author: string) {
  const body = req.method === "DELETE" ? {} : await bodyOf(req);
  if (rest === "typing" && req.method === "POST") {
    markTyping(path, id);
    return { typing: id };
  }
  if (rest === "link" && req.method === "POST") return linkNode(path, id, { text: stringOr(body["text"]), to: stringOr(body["to"]), near: typeof body["at"] === "number" ? body["at"] : 0 }, author);
  if (rest !== undefined) return undefined;
  if (req.method === "PATCH") return editNode(path, id, boxOf(body), author);
  if (req.method === "DELETE") return removeNode(path, id);
  return undefined;
}

async function canvasAction(req: Request, path: string, rest: string | undefined, author: string) {
  if (rest === undefined && req.method === "GET") return readCanvas(path);
  if (rest === undefined && req.method === "POST") return createCanvas(path);
  if (rest === "nodes" && req.method === "POST") return addNode(path, boxOf(await bodyOf(req)), author);
  const node = /^nodes\/([\w-]+)(?:\/(\w+))?$/.exec(rest ?? "");
  return node?.[1] === undefined ? undefined : nodeAction(req, path, node[1], node[2], author);
}

const USAGE = "GET or POST /api/canvas/<path>; POST <path>/nodes {text,x,y,width?,height?}; PATCH <path>/nodes/<id> {text?,base?,find?,replace?,append?,x?,y?,width?,height?}; POST <path>/nodes/<id>/typing; DELETE <path>/nodes/<id>; POST <path>/nodes/<id>/link {text,to,at?}";

// the server owns each canvas and writes one box at a time, so an agent's edit never clobbers the box Isaac is typing in
export async function canvasRoute(req: Request, url: URL): Promise<Response | undefined> {
  const m = /^\/api\/canvas\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);
  if (m?.[1] === undefined) return undefined;
  const author = sessions.get(req.headers.get("x-maxflow-from") ?? "")?.id ?? "isaac";
  try {
    const done = await canvasAction(req, decodeURIComponent(m[1]), m[2], author);
    if (done === undefined) return new Response(USAGE, { status: 400 });
    return Response.json(done, { status: req.method === "POST" && m[2]?.includes("/") !== true ? 201 : 200 });
  } catch (error) {
    if (error instanceof CanvasConflict) return Response.json(error.node, { status: 409 });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(message, { status: message.startsWith("no ") ? 404 : 400 });
  }
}
