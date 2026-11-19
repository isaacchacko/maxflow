import type { Server } from "bun";
import type { WsData } from "./sessions";
import { readFileSync } from "node:fs";
import { CLI } from "./instance";
import { type Role, sessions } from "./sessions";
import { createSession, dispatch } from "./lifecycle";
import { describe, freshWorld } from "./world";
import { ROUTER_BRIEF, acceptTrust } from "./routing";
import { handOff } from "./objectives";

export async function sessionsWorldRoute(req: Request, _url: URL, path: string, server: Server<WsData>): Promise<Response | undefined> {
  if (path === "/api/sessions" && req.method === "GET") return Response.json([...sessions.values()].map((s) => describe(s)));
  if (path === "/api/sessions" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { name?: string; cmd?: string[] | string; cwd?: string; role?: "router" | "worker"; parent?: string; objective?: string; scope?: string };
    // An agent a router starts is its worker; one started from a worker joins the same router.
    const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
    const parent = sessions.get(body.parent ?? "") ?? (from?.role?.role === "router" ? from : from?.role?.parent ? sessions.get(from.role.parent) : undefined);
    const objective = body.objective ?? parent?.role?.objective;
    const handingRole = body.role === "router" && from?.role?.role === "router" && from.role.objective === objective && (body.scope ?? from.role.scope) === from.role.scope ? from.role : undefined;
    const role: Role | undefined = body.role === "router" && objective ? { role: "router", objective, scope: handingRole?.scope ?? (body.scope || "Whole objective") } : parent && objective ? { role: "worker", objective, parent: parent.id } : undefined;
    // With no command, a router or worker is a claude (a router with its brief, as startRouter starts one), never the bare shell
    // that 662ba653 and b83e405d were: a shell holding a role takes his thread replies where nothing reads them.
    const agent = ["claude", "--permission-mode", "bypassPermissions", ...(role?.role === "router" ? ["--append-system-prompt", readFileSync(ROUTER_BRIEF, "utf8")] : [])];
    const cmd = typeof body.cmd === "string" ? ["zsh", "-lc", body.cmd] : body.cmd?.length ? body.cmd : role ? agent : [process.env.SHELL ?? "zsh", "-l"];
    const s = createSession(body.name || cmd.join(" ").slice(0, 40), cmd, body.cwd?.replace(/^~(?=\/|$)/, process.env.HOME!) || parent?.cwd || process.env.HOME!, undefined, role);
    if (cmd[0] === "claude") acceptTrust(s);
    if (handingRole && from) handOff(from, handingRole, s);
    // Spawned from the browser under a router: the router hears it has a new worker to brief.
    if (parent && !from) dispatch({ to: [parent], target: s.id, text: `[maxflow] The user started a worker for you, "${s.name}" (${s.id}). Brief it with \`${CLI} notify ${s.id} '<brief>'\`.` });
    return Response.json(describe(s), { status: 201 });
  }

  if (path === "/api/world" && req.method === "GET") {
    const b = await freshWorld();
    const etag = `"w${b.v}"`;
    const headers = { etag, "x-world-v": String(b.v), "cache-control": "no-cache" };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response((b.json ??= JSON.stringify(b.w)), { headers: { ...headers, "content-type": "application/json" } });
  }
  if (path === "/api/world/ws") return server.upgrade(req, { data: { id: "", world: true } }) ? undefined : new Response("upgrade failed", { status: 400 });
  return undefined;
}
