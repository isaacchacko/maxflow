import { mkdirSync } from "node:fs";
import { sessions } from "./sessions";
import { describe } from "./world-session";
import { introduce } from "./introduce";
import { UPLOADS } from "./uploads";
import { type Route, exactly, firstAnswer, jsonBody, matching, textOf } from "./route-kit";

function installedAppFile(path: string): { name: string; type: string } | undefined {
  if (path === "/manifest.webmanifest") return { name: "manifest.webmanifest", type: "application/manifest+json" };
  if (path === "/sw.js") return { name: "sw.js", type: "text/javascript" };
  if (!/^\/pwa\/[\w-]+\.(?:png|svg)$/.test(path)) return undefined;
  return { name: path.slice(5), type: path.endsWith(".svg") ? "image/svg+xml" : "image/png" };
}

// constraint: the service worker is served at the root because its scope is the folder it is served from
async function installedAppFileUncached(req: Request, _url: URL, path: string): Promise<Response | undefined> {
  const asked = installedAppFile(path);
  if (!asked || req.method !== "GET") return undefined;
  const file = Bun.file(new URL(asked.name === "favicon.svg" ? "src/favicon.svg" : `src/pwa/${asked.name}`, import.meta.url));
  return (await file.exists()) ? new Response(file, { headers: { "content-type": asked.type, "cache-control": "no-cache" } }) : new Response("not found", { status: 404 });
}

async function keepPastedImageAsAFileAnAgentCanRead(req: Request): Promise<Response> {
  const ext = /^image\/(png|jpeg|gif|webp)$/.exec(req.headers.get("content-type") ?? "")?.[1];
  if (ext === undefined) return new Response("png, jpeg, gif or webp image required", { status: 415 });
  mkdirSync(UPLOADS, { recursive: true });
  const file = `${UPLOADS}/${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.${ext === "jpeg" ? "jpg" : ext}`;
  await Bun.write(file, await req.arrayBuffer());
  return Response.json({ path: file });
}

async function upload(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "GET") return undefined;
  const file = Bun.file(`${UPLOADS}/${match[1] ?? ""}`);
  return (await file.exists()) ? new Response(file, { headers: { "cache-control": "max-age=31536000, immutable" } }) : new Response("no such upload", { status: 404 });
}

async function linkTwoSessions(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const a = sessions.get(textOf(body, "a") ?? "");
  const b = sessions.get(textOf(body, "b") ?? "");
  if (!a || !b || a === b) return new Response("two sessions required", { status: 400 });
  const why = textOf(body, "why")?.trim();
  introduce(a, b, why);
  introduce(b, a, why);
  return Response.json([describe(a), describe(b)]);
}

const ROUTES: Route[] = [
  installedAppFileUncached,
  exactly("POST", "/api/uploads", keepPastedImageAsAFileAnAgentCanRead),
  matching(/^\/api\/uploads\/(\w[\w.-]*)$/, upload),
  exactly("POST", "/api/link", linkTwoSessions),
];

export async function filesRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
