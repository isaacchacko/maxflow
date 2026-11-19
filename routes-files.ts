import { mkdirSync } from "node:fs";
import { sessions } from "./sessions";
import { describe } from "./world-session";
import { introduce } from "./introduce";
import { UPLOADS } from "./uploads";

export async function filesRoute(req: Request, _url: URL, path: string): Promise<Response | undefined> {
  // yarn as an installed app: its manifest, the service worker that makes it installable (at the root, so its scope is the whole
  // app) and the app icons. Never cached, so a change shows up on the next load.
  const pwa = path === "/manifest.webmanifest" ? ["manifest.webmanifest", "application/manifest+json"] : path === "/sw.js" ? ["sw.js", "text/javascript"] : path.match(/^\/pwa\/([\w-]+\.(?:png|svg))$/) ? [path.slice(5), path.endsWith(".svg") ? "image/svg+xml" : "image/png"] : null;
  if (pwa && req.method === "GET") {
    const file = Bun.file(pwa[0] === "favicon.svg" ? new URL("src/favicon.svg", import.meta.url) : new URL(`src/pwa/${pwa[0]}`, import.meta.url));
    return (await file.exists()) ? new Response(file, { headers: { "content-type": pwa[1], "cache-control": "no-cache" } }) : new Response("not found", { status: 404 });
  }
  // A pasted image is kept as a file, so the text it's pasted into carries a path the receiving agent can read.
  if (path === "/api/uploads" && req.method === "POST") {
    const ext = req.headers.get("content-type")?.match(/^image\/(png|jpeg|gif|webp)$/)?.[1];
    if (!ext) return new Response("png, jpeg, gif or webp image required", { status: 415 });
    mkdirSync(UPLOADS, { recursive: true });
    const file = `${UPLOADS}/${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.${ext === "jpeg" ? "jpg" : ext}`;
    await Bun.write(file, await req.arrayBuffer());
    return Response.json({ path: file });
  }
  const upload = path.match(/^\/api\/uploads\/(\w[\w.-]*)$/);
  if (upload && req.method === "GET") {
    const file = Bun.file(`${UPLOADS}/${upload[1]}`);
    return (await file.exists()) ? new Response(file, { headers: { "cache-control": "max-age=31536000, immutable" } }) : new Response("no such upload", { status: 404 });
  }
  if (path === "/api/link" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { a?: string; b?: string; why?: string };
    const a = sessions.get(body.a ?? ""), b = sessions.get(body.b ?? "");
    if (!a || !b || a === b) return new Response("two sessions required", { status: 400 });
    const why = body.why?.trim();
    introduce(a, b, why), introduce(b, a, why);
    return Response.json([describe(a), describe(b)]);
  }
  return undefined;
}
