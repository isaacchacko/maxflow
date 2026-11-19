import { agents, calendar, health, stats } from "./stats";
import { jev } from "./stats-jev";
import { sessions } from "./sessions";
import { TODO_STATES, type Todo } from "./model";
import { objectives, saveTodos, threads, todos } from "./stores";
import { describe } from "./world";
import { DAY } from "./dates";

export async function statsTodosRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  if (path === "/api/todos" && req.method === "GET") return Response.json(todos);
  if (path === "/api/stats" && req.method === "GET") return Response.json(await stats(url.searchParams.get("week") ?? undefined, url.searchParams.get("repo") ?? undefined));
  if (path === "/api/stats/calendar" && req.method === "GET") return Response.json(await calendar());
  if (path === "/api/stats/health" && req.method === "GET") return Response.json(health([...sessions.values()].map((s) => describe(s))));
  if (path === "/api/stats/jev" && req.method === "GET") return Response.json(jev(url.searchParams.get("days")));
  if (path === "/api/stats/agents" && req.method === "GET")
    return Response.json(agents(Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7)), [...sessions.values()].map((s) => describe(s)), objectives));
  if (path === "/api/todos" && req.method === "POST") {
    const { text, day } = (await req.json().catch(() => ({}))) as { text?: string; day?: string };
    if (!text?.trim() || !day || !DAY.test(day)) return new Response("text, and day as YYYY-MM-DD", { status: 400 });
    const todo: Todo = { id: crypto.randomUUID().slice(0, 8), text: text.trim(), day, state: "todo", at: new Date().toISOString(), threadIds: [] };
    todos.push(todo), saveTodos();
    return Response.json(todo, { status: 201 });
  }
  // Tagging a thread on a todo, or untagging it; each is idempotent, and answers with the todo.
  const todoThread = path.match(/^\/api\/todos\/([\w-]+)\/threads\/([\w-]+)$/);
  if (todoThread && (req.method === "POST" || req.method === "DELETE")) {
    const [, todoId, threadId] = todoThread;
    const todo = todos.find((t) => t.id === todoId);
    if (!todo) return new Response(`no todo ${todoId}`, { status: 404 });
    if (req.method === "POST") {
      if (!threads.some((t) => t.id === threadId)) return new Response(`no thread ${threadId}`, { status: 404 });
      if (!todo.threadIds.includes(threadId!)) todo.threadIds.push(threadId!);
    } else todo.threadIds = todo.threadIds.filter((id) => id !== threadId);
    saveTodos();
    return Response.json(todo);
  }
  const todoPath = path.match(/^\/api\/todos\/([\w-]+)$/);
  const todo = todoPath && todos.find((t) => t.id === todoPath[1]);
  if (todoPath && !todo) return new Response("no such todo", { status: 404 });
  if (todo && req.method === "PATCH") {
    const edit = (await req.json().catch(() => ({}))) as Partial<Pick<Todo, "text" | "day" | "state">>;
    if (edit.text !== undefined && !edit.text.trim()) return new Response("text can't be empty", { status: 400 });
    if (edit.day !== undefined && !DAY.test(edit.day)) return new Response("day as YYYY-MM-DD", { status: 400 });
    if (edit.state !== undefined && !TODO_STATES.includes(edit.state)) return new Response(`state: one of ${TODO_STATES.join(", ")}`, { status: 400 });
    if (edit.text !== undefined) todo.text = edit.text.trim();
    if (edit.day !== undefined) todo.day = edit.day;
    if (edit.state !== undefined) todo.state = edit.state;
    saveTodos();
    return Response.json(todo);
  }
  if (todo && req.method === "DELETE") return todos.splice(todos.indexOf(todo), 1), saveTodos(), new Response(null, { status: 204 });
  return undefined;
}
