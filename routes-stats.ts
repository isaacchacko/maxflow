import { agents, calendar, health, stats } from "./stats";
import { jev } from "./stats-jev";
import { briefResources, resources } from "./stats-resources";
import { type Session, sessions } from "./sessions";
import type { SessionInfo } from "./stats-health";
import { TODO_STATES, type Todo } from "./model";
import { objectives, saveTodos, threads, todos } from "./stores";
import { describe } from "./world-session";
import { DAY } from "./dates";
import { patch } from "./patch";
import { type Route, exactly, firstAnswer, jsonBody, matching, textOf } from "./route-kit";

function sessionInfoOf(s: Session): SessionInfo {
  const { role, ...described } = describe(s);
  return role === null ? described : { ...described, role };
}

const sessionInfos = () => sessions.values().map(sessionInfoOf).toArray();
const agentsSeen = (url: URL) => agents(agentWindowDays(url.searchParams.get("days")), sessionInfos(), objectives);

function agentWindowDays(asked: string | null) {
  const days = Number(asked);
  return Math.min(90, Math.max(1, days === 0 || Number.isNaN(days) ? 7 : days));
}

async function addTodo(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const text = textOf(body, "text")?.trim() ?? "";
  const day = textOf(body, "day") ?? "";
  if (text === "" || !DAY.test(day)) return new Response("text, and day as YYYY-MM-DD", { status: 400 });
  const todo: Todo = { id: crypto.randomUUID().slice(0, 8), text, day, state: "todo", at: new Date().toISOString(), threadIds: [] };
  todos.push(todo);
  saveTodos();
  return Response.json(todo, { status: 201 });
}

function tagOrUntagIdempotently(req: Request, _url: URL, match: RegExpExecArray): Response | undefined {
  if (req.method !== "POST" && req.method !== "DELETE") return undefined;
  const [, todoId = "", threadId = ""] = match;
  const todo = todos.find((t) => t.id === todoId);
  if (!todo) return new Response(`no todo ${todoId}`, { status: 404 });
  if (req.method === "POST") {
    if (threads.every((t) => t.id !== threadId)) return new Response(`no thread ${threadId}`, { status: 404 });
    if (!todo.threadIds.includes(threadId)) todo.threadIds.push(threadId);
  } else todo.threadIds = todo.threadIds.filter((id) => id !== threadId);
  saveTodos();
  return Response.json(todo);
}

async function editTodo(req: Request, todo: Todo): Promise<Response> {
  const edit = await jsonBody(req);
  const text = textOf(edit, "text");
  if (text?.trim() === "") return new Response("text can't be empty", { status: 400 });
  const day = textOf(edit, "day");
  if (day !== undefined && !DAY.test(day)) return new Response("day as YYYY-MM-DD", { status: 400 });
  const askedState = textOf(edit, "state");
  const state = TODO_STATES.find((s) => s === askedState);
  if (askedState !== undefined && state === undefined) return new Response(`state: one of ${TODO_STATES.join(", ")}`, { status: 400 });
  if (text !== undefined) patch(todo, { text: text.trim() });
  if (day !== undefined) patch(todo, { day });
  if (state !== undefined) patch(todo, { state });
  saveTodos();
  return Response.json(todo);
}

async function editOrDeleteTodo(req: Request, _url: URL, match: RegExpExecArray): Promise<Response | undefined> {
  const todo = todos.find((t) => t.id === match[1]);
  if (!todo) return new Response("no such todo", { status: 404 });
  if (req.method === "PATCH") return editTodo(req, todo);
  if (req.method !== "DELETE") return undefined;
  todos.splice(todos.indexOf(todo), 1);
  saveTodos();
  return new Response(null, { status: 204 });
}

const ROUTES: Route[] = [
  exactly("GET", "/api/todos", () => Response.json(todos)),
  exactly("GET", "/api/stats", (_req, url) => Response.json(stats(url.searchParams.get("week") ?? undefined, url.searchParams.get("repo") ?? undefined))),
  exactly("GET", "/api/stats/calendar", async () => Response.json(await calendar())),
  exactly("GET", "/api/stats/health", () => Response.json(health(sessionInfos()))),
  exactly("GET", "/api/stats/resources", (_req, url) => Response.json(url.searchParams.has("brief") ? briefResources() : (resources() ?? null))),
  exactly("GET", "/api/stats/jev", (_req, url) => Response.json(jev(url.searchParams.get("days")))),
  exactly("GET", "/api/stats/agents", (_req, url) => Response.json(agentsSeen(url))),
  exactly("POST", "/api/todos", addTodo),
  matching(/^\/api\/todos\/([\w-]+)\/threads\/([\w-]+)$/, tagOrUntagIdempotently),
  matching(/^\/api\/todos\/([\w-]+)$/, editOrDeleteTodo),
];

export async function statsTodosRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
