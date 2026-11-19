import { publish } from "./bus";
import { sessions } from "./sessions";
import { objectives, saveObjectives, saveTasks, saveThreads, tasks, threads } from "./stores";
import { dispatch, routersOf } from "./lifecycle";
import { describe } from "./world-session";
import { startRouter } from "./routing";
import { newObjective, setRole } from "./objectives";

export async function objectivesRoute(req: Request, _url: URL, path: string): Promise<Response | undefined> {
  if (path === "/api/objectives" && req.method === "GET") return Response.json(objectives);
  if (path === "/api/objectives" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { title?: string; cwd?: string; scope?: string };
    if (!body.title?.trim()) return new Response("title required", { status: 400 });
    const o = newObjective(body.title.trim(), body.cwd?.replace(/^~(?=\/|$)/, process.env.HOME!) || process.env.HOME!);
    const r = startRouter(o, body.scope?.trim() || "Whole objective");
    return Response.json({ ...o, router: r.id }, { status: 201 });
  }
  const objAct = path.match(/^\/api\/objectives\/([\w-]+)(?:\/(routers|merge))?$/);
  if (objAct) {
    const o = objectives.find((x) => x.id === objAct[1]);
    if (!o) return new Response("no such objective", { status: 404 });
    // Splitting a router: the new one takes the scope, the ones before it keep the rest.
    if (objAct[2] === "routers" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { scope?: string };
      const scope = body.scope?.trim();
      if (!scope) return new Response("scope required", { status: 400 });
      for (const r of routersOf(o.id)) {
        if (r.role!.scope === "Whole objective") setRole(r, { ...r.role!, scope: "Rest of the objective" });
        dispatch({ to: [r], target: o.id, text: `[maxflow] The user split the objective "${o.title}": a new router now owns "${scope}". Your scope is now: ${r.role!.scope}. Hand it anything of yours that falls in that scope.` });
      }
      return Response.json(describe(startRouter(o, scope)), { status: 201 });
    }
    // Merging: the target takes the source's agents, threads, tasks and signals; its routers keep the source's title as their scope.
    if (objAct[2] === "merge" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { into?: string };
      const into = objectives.find((x) => x.id === body.into);
      if (!into || into.id === o.id || into.closed) return new Response("into: an open objective other than this one", { status: 400 });
      const moved = [...sessions.values()].filter((s) => s.role?.objective === o.id);
      for (const s of moved) setRole(s, { ...s.role!, objective: into.id, ...(s.role!.role === "router" && { scope: o.title, merged: true }) });
      for (const t of threads) if (t.objective === o.id) t.objective = into.id;
      for (const t of tasks) if (t.objective === o.id) t.objective = into.id;
      Object.assign(o, { closed: true, mergedInto: into.id, page: [] });
      saveObjectives(), saveThreads(), saveTasks();
      publish(`objective/${o.id}`, { id: o.id, mergedInto: into.id });
      return Response.json({ from: o.id, into: into.id, sessions: moved.map((s) => s.id) });
    }
    if (req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { title?: string; closed?: boolean };
      if (body.title?.trim()) o.title = body.title.trim();
      if (typeof body.closed === "boolean") o.closed = body.closed;
      saveObjectives();
      return Response.json(o);
    }
  }
  return undefined;
}
