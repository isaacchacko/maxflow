import { existsSync } from "node:fs";
import { join } from "node:path";
import { commentsIn, DOCS_DIR, docPath, listDocs, moveDoc, obsidianUrl, ownerOf, readDoc, removeDoc, withOwner, writeDoc } from "./docs";
import { type Session, sessions } from "./sessions";

type Change = { text?: unknown; to?: unknown };

const notFound = (path: string) => new Response(`no doc ${path}`, { status: 404 });

async function changeOf(req: Request): Promise<Change> {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null ? body : {};
  } catch {
    return {};
  }
}

function shown(path: string) {
  const text = readDoc(path);
  return Response.json({ path, text, owner: ownerOf(text), comments: commentsIn(text), obsidian: obsidianUrl(path) });
}

function written(path: string, text: string, from: Session | undefined, isExisting: boolean) {
  const owned = !isExisting && from ? withOwner(text, from.id) : text;
  return Response.json({ path: writeDoc(path, owned, from?.name ?? "isaac") }, { status: isExisting ? 200 : 201 });
}

async function docAction(req: Request, path: string, from: Session | undefined) {
  const isExisting = existsSync(join(DOCS_DIR, path));
  if (req.method === "GET") return isExisting ? shown(path) : notFound(path);
  const change = await changeOf(req);
  if (req.method === "PUT" && typeof change.text === "string") return written(path, change.text, from, isExisting);
  if (!isExisting) return notFound(path);
  const who = from?.name ?? "isaac";
  if (req.method === "PATCH" && typeof change.to === "string") return Response.json({ path: moveDoc(path, change.to, who) });
  if (req.method === "DELETE") return Response.json({ path: removeDoc(path, who) });
  return new Response("GET, PUT {text}, PATCH {to} or DELETE", { status: 400 });
}

export async function docsRoute(req: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/api/docs" && req.method === "GET") return Response.json({ dir: DOCS_DIR, docs: listDocs() });
  const doc = /^\/api\/docs\/(.+)$/.exec(url.pathname)?.[1];
  if (doc === undefined) return undefined;
  try {
    return await docAction(req, docPath(decodeURIComponent(doc)), sessions.get(req.headers.get("x-maxflow-from") ?? ""));
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
  }
}
