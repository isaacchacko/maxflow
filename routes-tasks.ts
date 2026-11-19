import { writeStateJson } from "./state";
import { isSentry, sessions } from "./sessions";
import { candidates } from "./mentions";
import { TaskEdit } from "./model";
import { tasks } from "./stores";
import { editTask } from "./lifecycle";
import { ARCHIVED_LINKS, archivedLinks } from "./world";
import { openUserComments } from "./events";
import { prProgress } from "./task-prs";

export async function tasksLinksRoute(req: Request, _url: URL, path: string): Promise<Response | undefined> {
  if (path === "/api/tasks" && req.method === "GET") return Response.json(tasks.map((t) => ({ ...t, prs: prProgress(t) })));
  if (path === "/api/comments" && req.method === "GET") return Response.json(openUserComments());
  const task = path.match(/^\/api\/tasks(?:\/(\d+))?$/);
  if (task && req.method === "POST") {
    const t = task[1] ? tasks.find((o) => o.id === Number(task[1])) : undefined;
    if (task[1] && !t) return new Response("no such task", { status: 404 });
    const done = editTask(t, (await req.json().catch(() => ({}))) as TaskEdit);
    return typeof done === "string" ? new Response(done, { status: 400 }) : Response.json(done, { status: t ? 200 : 201 });
  }
  if (path === "/api/links" && req.method === "GET")
    return Response.json([...sessions.values()].filter((s) => !isSentry(s)).map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, running: s.exitCode === null, candidates: candidates(s) })));

  if (path === "/api/links" && req.method === "PATCH") {
    const body = (await req.json().catch(() => ({}))) as { urls?: string[]; archived?: boolean };
    if (!body.urls?.length || typeof body.archived !== "boolean") return new Response("urls and archived required", { status: 400 });
    for (const u of body.urls) body.archived ? archivedLinks.add(u) : archivedLinks.delete(u);
    writeStateJson(ARCHIVED_LINKS, [...archivedLinks]);
    return new Response(null, { status: 204 });
  }
  return undefined;
}
