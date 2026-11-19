import { homedir } from "node:os";
import { publish } from "./bus";
import { type Session, sessions } from "./sessions";
import type { Objective } from "./model";
import { objectives, saveObjectives, saveTasks, saveThreads, tasks, threads } from "./stores";
import { dispatch, routersOf } from "./lifecycle";
import { describe } from "./world-session";
import { startRouter } from "./routing";
import { newObjective, setRole } from "./objectives";
import { patch } from "./patch";
import { isFilled } from "./shared/guards";
import { type Route, exactly, expandHome, firstAnswer, flagOf, jsonBody, matching, textOf } from "./route-kit";

async function startObjectiveWithARouter(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const title = textOf(body, "title")?.trim() ?? "";
  if (title === "") return new Response("title required", { status: 400 });
  const cwd = expandHome(textOf(body, "cwd") ?? "");
  const o = newObjective(title, isFilled(cwd) ? cwd : homedir());
  const scope = textOf(body, "scope")?.trim() ?? "";
  const r = startRouter(o, scope === "" ? "Whole objective" : scope);
  return Response.json({ ...o, router: r.id }, { status: 201 });
}

function handTheRestToAnEarlierRouter(r: Session, o: Objective, scope: string) {
  const role = r.role;
  if (role?.scope === "Whole objective") setRole(r, { ...role, scope: "Rest of the objective" });
  dispatch({ to: [r], target: o.id, text: `[maxflow] The user split the objective "${o.title}": a new router now owns "${scope}". Your scope is now: ${String(r.role?.scope)}. Hand it anything of yours that falls in that scope.` });
}

async function splitOffANewRouterForTheScope(req: Request, o: Objective): Promise<Response> {
  const scope = textOf(await jsonBody(req), "scope")?.trim() ?? "";
  if (scope === "") return new Response("scope required", { status: 400 });
  for (const r of routersOf(o.id)) handTheRestToAnEarlierRouter(r, o, scope);
  return Response.json(describe(startRouter(o, scope)), { status: 201 });
}

function moveAgentsKeepingTheSourceTitleAsRouterScope(o: Objective, into: Objective): Session[] {
  const moved: Session[] = [];
  for (const s of sessions.values()) {
    const role = s.role;
    if (role?.objective !== o.id) continue;
    moved.push(s);
    setRole(s, { ...role, objective: into.id, ...(role.role === "router" && { scope: o.title, merged: true }) });
  }
  return moved;
}

async function mergeInto(req: Request, o: Objective): Promise<Response> {
  const body = await jsonBody(req);
  const into = objectives.find((x) => x.id === body["into"]);
  if (!into || into.id === o.id || into.closed === true) return new Response("into: an open objective other than this one", { status: 400 });
  const moved = moveAgentsKeepingTheSourceTitleAsRouterScope(o, into);
  for (const t of threads) if (t.objective === o.id) t.objective = into.id;
  for (const t of tasks) if (t.objective === o.id) t.objective = into.id;
  patch(o, { closed: true, mergedInto: into.id, page: [] });
  saveObjectives();
  saveThreads();
  saveTasks();
  publish(`objective/${o.id}`, { id: o.id, mergedInto: into.id });
  return Response.json({ from: o.id, into: into.id, sessions: moved.map((s) => s.id) });
}

async function renameOrClose(req: Request, o: Objective): Promise<Response> {
  const body = await jsonBody(req);
  const title = textOf(body, "title")?.trim() ?? "";
  const closed = flagOf(body, "closed");
  if (title !== "") patch(o, { title });
  if (closed !== undefined) patch(o, { closed });
  saveObjectives();
  return Response.json(o);
}

async function actOnObjective(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  const [, id, action] = match;
  const o = objectives.find((x) => x.id === id);
  if (!o) return new Response("no such objective", { status: 404 });
  if (action === "routers" && req.method === "POST") return splitOffANewRouterForTheScope(req, o);
  if (action === "merge" && req.method === "POST") return mergeInto(req, o);
  return req.method === "PATCH" ? renameOrClose(req, o) : undefined;
}

const ROUTES: Route[] = [
  exactly("GET", "/api/objectives", () => Response.json(objectives)),
  exactly("POST", "/api/objectives", startObjectiveWithARouter),
  matching(/^\/api\/objectives\/([\w-]+)(?:\/(routers|merge))?$/, actOnObjective),
];

export async function objectivesRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
