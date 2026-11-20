import type { Server } from "bun";
import { homedir } from "node:os";
import type { WsData } from "./sessions";
import { readFileSync } from "node:fs";
import { CLI } from "./instance";
import { type Role, type Session, sessions } from "./sessions";
import { createSession, dispatch } from "./lifecycle";
import { freshWorld } from "./world";
import { describe } from "./world-session";
import { ROUTER_BRIEF, acceptTrust } from "./routing";
import { askOldRouterToBriefTheNew, handOff } from "./objectives";
import { isFilled } from "./shared/guards";
import { type Body, type Route, exactly, expandHome, firstAnswer, isStringList, jsonBody, sender, textOf } from "./route-kit";

function routerTheNewAgentWorksFor(from: Session | undefined, asked = ""): Session | undefined {
  const named = sessions.get(asked);
  if (named) return named;
  if (from?.role?.role === "router") return from;
  return isFilled(from?.role?.parent) ? sessions.get(from.role.parent) : undefined;
}

function roleHandedOverByTheCallingRouter(from: Session | undefined, askedRole: string | undefined, objective: string | undefined, scope: string | undefined): Role | undefined {
  const fromRole = from?.role;
  if (askedRole !== "router" || fromRole?.role !== "router" || fromRole.objective !== objective) return undefined;
  return (scope ?? fromRole.scope) === fromRole.scope ? fromRole : undefined;
}

function roleOf(askedRole: string | undefined, objective: string | undefined, parent: Session | undefined, scope: string): Role | undefined {
  if (!isFilled(objective)) return undefined;
  if (askedRole === "router") return { role: "router", objective, scope };
  return parent ? { role: "worker", objective, parent: parent.id } : undefined;
}

export function claudeForARoleNeverABareShellThatWouldDropHisThreadReplies(role: Role): string[] {
  return ["claude", "--permission-mode", "bypassPermissions", ...(role.role === "router" ? ["--append-system-prompt", readFileSync(ROUTER_BRIEF, "utf8")] : [])];
}

function commandOf(asked: unknown, role: Role | undefined): string[] {
  if (typeof asked === "string") return ["zsh", "-lc", asked];
  if (isStringList(asked) && asked.length > 0) return asked;
  if (role) return claudeForARoleNeverABareShellThatWouldDropHisThreadReplies(role);
  return [process.env["SHELL"] ?? "zsh", "-l"];
}

function tellTheRouterItHasANewWorkerFromTheBrowser(router: Session, worker: Session) {
  dispatch({ to: [router], target: worker.id, text: `[maxflow] The user started a worker for you, "${worker.name}" (${worker.id}). Brief it with \`${CLI} notify ${worker.id} '<brief>'\`.` });
}

function placeInTheObjective(body: Body, from: Session | undefined) {
  const askedRole = textOf(body, "role");
  const askedScope = textOf(body, "scope");
  const parent = routerTheNewAgentWorksFor(from, textOf(body, "parent"));
  const objective = textOf(body, "objective") ?? parent?.role?.objective;
  const handingRole = roleHandedOverByTheCallingRouter(from, askedRole, objective, askedScope);
  const role = roleOf(askedRole, objective, parent, handingRole?.scope ?? (isFilled(askedScope) ? askedScope : "Whole objective"));
  return { parent, handingRole, role };
}

async function startSession(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const from = sender(req);
  const { parent, handingRole, role } = placeInTheObjective(body, from);
  const cmd = commandOf(body["cmd"], role);
  const name = textOf(body, "name");
  const cwd = [expandHome(textOf(body, "cwd") ?? ""), parent?.cwd].find(isFilled) ?? homedir();
  const s = createSession(isFilled(name) ? name : cmd.join(" ").slice(0, 40), cmd, cwd, { role });
  if (cmd[0] === "claude") void acceptTrust(s);
  if (handingRole && from) askOldRouterToBriefTheNew(from, handingRole, s, handOff(from, handingRole, s));
  if (parent && !from) tellTheRouterItHasANewWorkerFromTheBrowser(parent, s);
  return Response.json(describe(s), { status: 201 });
}

async function world(req: Request): Promise<Response> {
  const b = await freshWorld();
  const etag = `"w${b.v}"`;
  const headers = { etag, "x-world-v": String(b.v), "cache-control": "no-cache" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response((b.json ??= JSON.stringify(b.w)), { headers: { ...headers, "content-type": "application/json" } });
}

const ROUTES: Route[] = [
  exactly("GET", "/api/sessions", () => Response.json(sessions.values().map((s) => describe(s)).toArray())),
  exactly("POST", "/api/sessions", startSession),
  exactly("GET", "/api/world", world),
];

export async function sessionsWorldRoute(req: Request, url: URL, path: string, server: Server<WsData>): Promise<Response | undefined> {
  const answer = await firstAnswer(ROUTES, req, url, path);
  if (answer !== undefined || path !== "/api/world/ws") return answer;
  return server.upgrade(req, { data: { id: "", world: true } }) ? undefined : new Response("upgrade failed", { status: 400 });
}
