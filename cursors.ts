import { sessions } from "./sessions";
import { isRecord, stringOr } from "./shared/guards";
import { worldClients } from "./world";

export type Cursor = { type: "cursor"; agent: string; name: string; action: string; targets: string[]; at: number };
type Seen = { body: Record<string, unknown>; reply: Record<string, unknown> };
type Aim = { action: string; targets: string[] };
type Rule = { method: string; path: RegExp; aim: (m: RegExpExecArray, seen: Seen) => Aim };

const PLUMBING = /^\/api\/(touch|events|browsers?|files|uploads|sessions\/[\w-]+\/(state|await|screen|intro|input))(\/|$)/;

const lastMessage = (reply: Record<string, unknown>) => {
  const messages = reply["messages"];
  const last: unknown = Array.isArray(messages) ? messages.at(-1) : undefined;
  return isRecord(last) ? stringOr(last["id"]) : "";
};

const aboutThread = (id: string) => [`inbox-row:${id}`, `thread-title:${id}`, `pinned:${id}`];

const inThread = (id: string, reply: Record<string, unknown>) => {
  const thread = stringOr(reply["id"], id);
  const message = lastMessage(reply);
  return [...(message === "" ? [] : [`message:${message}`]), ...aboutThread(thread)];
};

const docTargets = (path: string) => {
  const doc = decodeURIComponent(path);
  return [`docs:doc:${doc}`, `docs:doc:${doc}.md`, `docs:folder:${doc}`];
};

const taskTargets = (id: string) => [`row:t${id}`, `page-title:task/t${id}`, `worker-task:t${id}`, `card-task:t${id}`];

function taskAction(id: string | undefined, body: Record<string, unknown>) {
  if (typeof body["status"] === "string") return `move task to ${body["status"]}`;
  return id === undefined ? "new task" : "edit task";
}

const RULES: Rule[] = [
  { method: "POST", path: /^\/api\/threads\/([\w-]+)\/messages$/, aim: (m, { reply }) => ({ action: "post", targets: inThread(m[1] ?? "", reply) }) },
  { method: "POST", path: /^\/api\/threads$/, aim: (_, { reply }) => ({ action: "new thread", targets: inThread("", reply) }) },
  { method: "POST", path: /^\/api\/asks$/, aim: (_, { reply }) => ({ action: "ask", targets: inThread("", reply) }) },
  { method: "POST", path: /^\/api\/threads\/([\w-]+)\/status$/, aim: m => ({ action: "status", targets: aboutThread(m[1] ?? "") }) },
  { method: "POST", path: /^\/api\/threads\/([\w-]+)\/(split|merge)$/, aim: m => ({ action: m[2] ?? "", targets: aboutThread(m[1] ?? "") }) },
  {
    method: "POST",
    path: /^\/api\/threads\/([\w-]+)\/objective$/,
    aim: (m, { body }) => ({ action: "move thread", targets: [...aboutThread(m[1] ?? ""), `objective:${stringOr(body["objective"])}`] }),
  },
  {
    method: "POST",
    path: /^\/api\/tasks(?:\/(\d+))?$/,
    aim: (m, { body, reply }) => ({ action: taskAction(m[1], body), targets: taskTargets(m[1] ?? String(reply["id"])) }),
  },
  { method: "POST", path: /^\/api\/todos\/([\w-]+)\/threads\/([\w-]+)$/, aim: m => ({ action: "tag todo", targets: [`todo:${m[1] ?? ""}`] }) },
  { method: "DELETE", path: /^\/api\/todos\/([\w-]+)\/threads\/([\w-]+)$/, aim: m => ({ action: "untag todo", targets: [`todo:${m[1] ?? ""}`] }) },
  { method: "PATCH", path: /^\/api\/sessions\/([\w-]+)$/, aim: m => ({ action: "rename", targets: [`agent-name:${m[1] ?? ""}`, `agent:${m[1] ?? ""}`, `agent-link:${m[1] ?? ""}`] }) },
  { method: "PATCH", path: /^\/api\/objectives\/([\w-]+)$/, aim: m => ({ action: "rename objective", targets: [`objective:${m[1] ?? ""}`, `page-title:objective/${m[1] ?? ""}`] }) },
  {
    method: "POST",
    path: /^\/api\/pages$/,
    aim: (_, { body }) => ({ action: "edit card", targets: [`block:${isRecord(body["block"]) ? stringOr(body["block"]["id"]) : ""}`, `page-title:${stringOr(body["ref"])}`] }),
  },
  { method: "DELETE", path: /^\/api\/pages$/, aim: (_, { body }) => ({ action: "remove card", targets: [`page-title:${stringOr(body["ref"])}`] }) },
  { method: "PUT", path: /^\/api\/docs\/(.+)$/, aim: m => ({ action: "edit doc", targets: docTargets(m[1] ?? "") }) },
  { method: "POST", path: /^\/api\/docs-folder\/(.+)$/, aim: m => ({ action: "new folder", targets: docTargets(m[1] ?? "") }) },
  { method: "PATCH", path: /^\/api\/docs\/(.+)$/, aim: m => ({ action: "move doc", targets: docTargets(m[1] ?? "") }) },
];

const unmapped = (method: string, path: string): Aim => ({ action: `${method} ${path.replace(/^\/api\//, "").replaceAll(/\/[\w-]*\d[\w-]*/g, "/:id")}`, targets: [] });

function aimOf(method: string, path: string, seen: Seen): Aim {
  for (const rule of RULES) {
    const m = rule.method === method ? rule.path.exec(path) : null;
    if (m) return rule.aim(m, seen);
  }
  return unmapped(method, path);
}

async function jsonOf(r: Request | Response) {
  try {
    const value: unknown = await r.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function send(agent: { id: string; name: string }, req: Request, sent: Request, reply: Response) {
  const path = new URL(req.url).pathname;
  const seen = { body: await jsonOf(sent), reply: await jsonOf(reply) };
  try {
    const cursor: Cursor = { type: "cursor", agent: agent.id, name: agent.name, ...aimOf(req.method, path, seen), at: Date.now() };
    const msg = JSON.stringify(cursor);
    for (const ws of worldClients) ws.sendText(msg);
  } catch (error) {
    console.error("cursor event dropped:", error);
  }
}

type Answer<S> = (req: Request, server: S) => Promise<Response | undefined>;

export const withCursors = <S>(answer: Answer<S>) => async (req: Request, server: S) => {
  const agent = sessions.get(req.headers.get("x-maxflow-from") ?? "");
  const isAction = agent !== undefined && req.method !== "GET" && !PLUMBING.test(new URL(req.url).pathname);
  const sent = isAction ? req.clone() : undefined;
  const res = await answer(req, server);
  if (!agent || !sent || res?.ok !== true || worldClients.size === 0) return res;
  void send(agent, req, sent, res.clone());
  return res;
};
