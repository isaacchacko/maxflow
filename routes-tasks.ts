import { writeStateJson } from "./state";
import { isSentry, sessions } from "./sessions";
import { candidates } from "./mentions";
import { TASK_STATUSES, type TaskEdit } from "./model";
import { tasks } from "./stores";
import { editTask } from "./lifecycle";
import { ARCHIVED_LINKS, archivedLinks } from "./world-session";
import { openUserComments } from "./events";
import { prProgress } from "./task-prs";
import { isFilled } from "./shared/guards";
import { type Body, type Route, exactly, firstAnswer, flagOf, jsonBody, matching, textOf, textsOf } from "./route-kit";

const TASK_KINDS = ["task", "question"] as const;

function taskEditOf(body: Body): TaskEdit {
  const [title, answer, objective, session, link, event] = ["title", "answer", "objective", "session", "link", "event"].map((key) => textOf(body, key));
  const kind = TASK_KINDS.find((k) => k === body["kind"]);
  const status = TASK_STATUSES.find((s) => s === body["status"]);
  const at = typeof body["at"] === "number" ? body["at"] : undefined;
  return {
    ...(title !== undefined && { title }),
    ...(kind !== undefined && { kind }),
    ...(status !== undefined && { status }),
    ...(answer !== undefined && { answer }),
    ...(objective !== undefined && { objective }),
    ...(session !== undefined && { session }),
    ...(link !== undefined && { link }),
    ...(event !== undefined && { event }),
    ...(at !== undefined && { at }),
  };
}

const isUnknownStatus = (body: Body) => {
  const status = textOf(body, "status");
  return isFilled(status) && TASK_STATUSES.every((s) => s !== status);
};

async function createOrEditTask(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  if (req.method !== "POST") return undefined;
  const [, id] = match;
  const t = id === undefined ? undefined : tasks.find((o) => o.id === Number(id));
  if (id !== undefined && !t) return new Response("no such task", { status: 404 });
  const body = await jsonBody(req);
  if (isUnknownStatus(body)) return new Response(`status is one of ${TASK_STATUSES.join(", ")}`, { status: 400 });
  const done = editTask(t, taskEditOf(body));
  return typeof done === "string" ? new Response(done, { status: 400 }) : Response.json(done, { status: t ? 200 : 201 });
}

const linkCandidates = () =>
  sessions
    .values()
    .filter((s) => !isSentry(s))
    .map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, running: s.exitCode === null, candidates: candidates(s) }))
    .toArray();

async function archiveOrUnarchiveLinks(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const urls = textsOf(body, "urls") ?? [];
  const isArchived = flagOf(body, "archived");
  if (isArchived === undefined || urls.length === 0) return new Response("urls and archived required", { status: 400 });
  for (const u of urls) {
    if (isArchived) archivedLinks.add(u);
    else archivedLinks.delete(u);
  }
  writeStateJson(ARCHIVED_LINKS, [...archivedLinks]);
  return new Response(null, { status: 204 });
}

const ROUTES: Route[] = [
  exactly("GET", "/api/tasks", () => Response.json(tasks.map((t) => ({ ...t, prs: prProgress(t) })))),
  exactly("GET", "/api/comments", () => Response.json(openUserComments())),
  matching(/^\/api\/tasks(?:\/(\d+))?$/, createOrEditTask),
  exactly("GET", "/api/links", () => Response.json(linkCandidates())),
  exactly("PATCH", "/api/links", archiveOrUnarchiveLinks),
];

export async function tasksLinksRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
