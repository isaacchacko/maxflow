import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  commentsIn,
  DOCS_DIR,
  docPath,
  listVault,
  makeFolder,
  moveDoc,
  moveFolder,
  obsidianUrl,
  ownerOf,
  readDoc,
  removeDoc,
  removeFolder,
  saveFile,
  vaultPath,
  versionOf,
  withOwner,
  writeDoc,
} from "./docs";
import { type Session, sessions } from "./sessions";

type Change = { text?: unknown; to?: unknown; base?: unknown };

const notFound = (path: string) => new Response(`no doc ${path}`, { status: 404 });
const isMarkdown = (path: string) => path.endsWith(".md");

async function changeOf(req: Request): Promise<Change> {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null ? body : {};
  } catch {
    return {};
  }
}

function shown(path: string) {
  if (!isMarkdown(path)) return new Response(Bun.file(join(DOCS_DIR, path)));
  const text = readDoc(path);
  return Response.json({ path, text, version: versionOf(text), owner: ownerOf(text), comments: commentsIn(text), obsidian: obsidianUrl(path) });
}

function conflict(path: string) {
  const text = readDoc(path);
  return Response.json({ path, text, version: versionOf(text) }, { status: 409 });
}

function written(path: string, text: string, from: Session | undefined, isExisting: boolean) {
  const status = isExisting ? 200 : 201;
  if (!from) return Response.json({ path: saveFile(path, text), version: versionOf(text) }, { status });
  const owned = isExisting ? text : withOwner(text, from.id);
  return Response.json({ path: writeDoc(path, owned, from.name), version: versionOf(owned) }, { status });
}

async function put(req: Request, path: string, from: Session | undefined, isExisting: boolean) {
  if (!isMarkdown(path)) {
    const bytes = new Uint8Array(await req.arrayBuffer());
    return Response.json({ path: saveFile(path, bytes) }, { status: 201 });
  }
  const change = await changeOf(req);
  if (typeof change.text !== "string") return new Response("PUT {text, base?}", { status: 400 });
  const isStale = isExisting && typeof change.base === "string" && versionOf(readDoc(path)) !== change.base;
  return isStale ? conflict(path) : written(path, change.text, from, isExisting);
}

async function docAction(req: Request, path: string, from: Session | undefined) {
  const isExisting = existsSync(join(DOCS_DIR, path));
  if (req.method === "PUT") return put(req, path, from, isExisting);
  if (!isExisting) return notFound(path);
  if (req.method === "GET") return shown(path);
  const who = from?.name ?? "isaac";
  const change = await changeOf(req);
  if (req.method === "PATCH" && typeof change.to === "string") return Response.json({ path: moveDoc(path, change.to, who) });
  if (req.method === "DELETE") return Response.json({ path: removeDoc(path, who) });
  return new Response("GET, PUT {text, base?} or raw bytes, PATCH {to} or DELETE", { status: 400 });
}

async function folderAction(req: Request, path: string, from: Session | undefined) {
  if (req.method === "POST") {
    makeFolder(path);
    return Response.json({ path }, { status: 201 });
  }
  if (!existsSync(join(DOCS_DIR, path))) return notFound(path);
  const who = from?.name ?? "isaac";
  const change = await changeOf(req);
  if (req.method === "PATCH" && typeof change.to === "string") return Response.json({ path: moveFolder(path, change.to, who) });
  if (req.method === "DELETE") return Response.json({ path: removeFolder(path, who) });
  return new Response("POST, PATCH {to} or DELETE", { status: 400 });
}

function routeOf(pathname: string) {
  const m = /^\/api\/docs(-folder)?\/(.+)$/.exec(pathname);
  if (m?.[2] === undefined) return;
  const path = decodeURIComponent(m[2]);
  return m[1] === undefined ? { act: docAction, path: docPath(path) } : { act: folderAction, path: vaultPath(path) };
}

export async function docsRoute(req: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/api/docs" && req.method === "GET") return Response.json({ dir: DOCS_DIR, ...listVault() });
  try {
    const route = routeOf(url.pathname);
    if (!route) return undefined;
    return await route.act(req, route.path, sessions.get(req.headers.get("x-maxflow-from") ?? ""));
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
  }
}
