import { sessions } from "./sessions";
import { isRecord, stringOr } from "./shared/guards";
import { threads } from "./stores";
import { worldClients } from "./world";

export type Gesture = "drag" | "edit" | "create" | "delete";
type Aim = { gesture: Gesture; action: string; to: string[]; from?: string[]; into?: string[]; carry?: string; onPlane?: { x: number; y: number }; holds: string[] };
export type Cursor = Aim & { type: "cursor"; agent: string; name: string; at: number };
type Seen = { body: Record<string, unknown>; reply: Record<string, unknown> };
type Rule = { method: string; path: RegExp; aim: (m: RegExpExecArray, seen: Seen) => Aim | undefined };

const threadRow = (id: string) => [`inbox-row:${id}`, `thread-card:${id}`, `thread-title:${id}`, `pinned:${id}`];
const titleOfThread = (id: string) => threads.find(t => t.id === id)?.title;

const docRow = (path: string) => [`docs:doc:${path}`, `docs:doc:${path}.md`, `docs:folder:${path}`];
const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");
const holdDoc = (path: string) => ["docs", `doc:${path}`, `doc:${path}.md`];

const taskRow = (ref: string) => [`row:${ref}`, `page-title:task/${ref}`, `worker-task:${ref}`, `card-task:${ref}`];
const pageHold = (ref: string) => {
  const [type, id = ""] = ref.split("/", 2);
  return type === "task" ? `tasks:${id}` : `objectives:${id}`;
};

function taskAim(id: string | undefined, { body, reply }: Seen): Aim | undefined {
  const ref = `t${id ?? stringOr(reply["id"])}`;
  const holds = [`tasks:${ref}`];
  if (id === undefined) {
    const objective = stringOr(reply["objective"], stringOr(body["objective"]));
    return { gesture: "create", action: "new task", to: [`row:${ref}`], into: [`tasks:${objective}`], holds: [...holds, `objectives:${objective}`] };
  }
  if (typeof body["status"] === "string") return { gesture: "edit", action: `mark ${body["status"]}`, to: taskRow(ref), holds };
  if (typeof body["title"] === "string") return { gesture: "edit", action: "retitle task", to: taskRow(ref), holds };
  return undefined;
}

function docMove(path: string, to: string): Aim {
  const holds = [...holdDoc(path), ...holdDoc(to)];
  if (dirOf(path) === dirOf(to)) return { gesture: "edit", action: "rename doc", to: docRow(path), holds };
  return { gesture: "drag", action: "move doc", from: docRow(path), to: [`docs:folder:${dirOf(to)}`], holds };
}

const canvasFile = (path: string) => {
  const file = decodeURIComponent(path);
  return file.endsWith(".canvas") ? file : `${file}.canvas`;
};
const boxOf = (file: string, id: unknown) => `canvas:node:${file}:${stringOr(id)}`;
const numberOr = (v: unknown) => (typeof v === "number" ? v : undefined);
const planeAt = (x: unknown, y: unknown) => {
  const [px, py] = [numberOr(x), numberOr(y)];
  return px === undefined || py === undefined ? undefined : { x: px, y: py };
};

function boxEdit(file: string, id: string, body: Record<string, unknown>): Aim {
  const box = [boxOf(file, id)];
  const holds = [`canvas:${file}`];
  const onPlane = planeAt(body["x"], body["y"]);
  if (typeof body["text"] === "string") return { gesture: "edit", action: "edit box", to: box, holds };
  if (body["width"] !== undefined || body["height"] !== undefined || !onPlane) return { gesture: "edit", action: "resize box", to: box, holds };
  return { gesture: "drag", action: "move box", from: box, to: [`canvas:plane:${file}`], onPlane, holds };
}

const CANVAS_RULES: Rule[] = [
  {
    method: "POST",
    path: /^\/api\/canvas\/([^/]+)$/,
    aim: m => {
      const file = canvasFile(m[1] ?? "");
      return { gesture: "create", action: "new canvas", to: docRow(file), into: [`docs:folder:${dirOf(file)}`, "docs:tree"], holds: ["docs"] };
    },
  },
  {
    method: "POST",
    path: /^\/api\/canvas\/([^/]+)\/nodes$/,
    aim: (m, { body, reply }) => {
      const file = canvasFile(m[1] ?? "");
      const onPlane = planeAt(body["x"], body["y"]);
      return { gesture: "create", action: "add box", to: [boxOf(file, reply["id"])], into: [`canvas:plane:${file}`], ...(onPlane && { onPlane }), holds: [`canvas:${file}`] };
    },
  },
  { method: "PATCH", path: /^\/api\/canvas\/([^/]+)\/nodes\/([\w-]+)$/, aim: (m, { body }) => boxEdit(canvasFile(m[1] ?? ""), m[2] ?? "", body) },
  {
    method: "DELETE",
    path: /^\/api\/canvas\/([^/]+)\/nodes\/([\w-]+)$/,
    aim: m => {
      const file = canvasFile(m[1] ?? "");
      return { gesture: "delete", action: "delete box", to: [boxOf(file, m[2])], holds: [`canvas:${file}`] };
    },
  },
  {
    method: "POST",
    path: /^\/api\/canvas\/([^/]+)\/nodes\/([\w-]+)\/link$/,
    aim: (m, { body }) => {
      const file = canvasFile(m[1] ?? "");
      return { gesture: "drag", action: "link", from: [boxOf(file, m[2])], to: [boxOf(file, body["to"])], carry: stringOr(body["text"], "link"), holds: [`canvas:${file}`] };
    },
  },
];

const RULES: Rule[] = [
  ...CANVAS_RULES,
  {
    method: "POST",
    path: /^\/api\/threads\/([\w-]+)\/objective$/,
    aim: (m, { body }) => {
      const objective = stringOr(body["objective"]);
      return { gesture: "drag", action: "move thread", from: threadRow(m[1] ?? ""), to: [`objective:${objective}`], holds: [`threads:${m[1] ?? ""}`, `objectives:${objective}`] };
    },
  },
  {
    method: "POST",
    path: /^\/api\/threads\/([\w-]+)\/merge$/,
    aim: (m, { body }) => {
      const into = stringOr(body["into"]);
      return { gesture: "drag", action: "merge thread", from: threadRow(m[1] ?? ""), to: threadRow(into), holds: [`threads:${m[1] ?? ""}`, `threads:${into}`] };
    },
  },
  { method: "POST", path: /^\/api\/tasks(?:\/(\d+))?$/, aim: (m, seen) => taskAim(m[1], seen) },
  {
    method: "POST",
    path: /^\/api\/todos\/([\w-]+)\/threads\/([\w-]+)$/,
    aim: m => ({ gesture: "drag", action: "tag todo", from: threadRow(m[2] ?? ""), to: [`todo:${m[1] ?? ""}`], carry: titleOfThread(m[2] ?? ""), holds: ["todos"] }),
  },
  {
    method: "PATCH",
    path: /^\/api\/sessions\/([\w-]+)$/,
    aim: (m, { body }) =>
      typeof body["name"] === "string" ? { gesture: "edit", action: "rename", to: [`agent-name:${m[1] ?? ""}`, `agent:${m[1] ?? ""}`, `agent-link:${m[1] ?? ""}`], holds: [`agents:${m[1] ?? ""}`] } : undefined,
  },
  {
    method: "PATCH",
    path: /^\/api\/objectives\/([\w-]+)$/,
    aim: (m, { body }) =>
      typeof body["title"] === "string" ? { gesture: "edit", action: "rename objective", to: [`page-title:objective/${m[1] ?? ""}`, `objective:${m[1] ?? ""}`], holds: [`objectives:${m[1] ?? ""}`] } : undefined,
  },
  {
    method: "POST",
    path: /^\/api\/pages$/,
    aim: (_, { body }) => {
      const ref = stringOr(body["ref"]);
      const block = isRecord(body["block"]) ? stringOr(body["block"]["id"]) : "";
      return { gesture: "edit", action: "edit card", to: [`block:${block}`], into: ["page"], holds: [pageHold(ref)] };
    },
  },
  {
    method: "DELETE",
    path: /^\/api\/pages$/,
    aim: (_, { body }) => {
      const ref = stringOr(body["ref"]);
      return { gesture: "delete", action: "remove card", to: [`block:${stringOr(body["id"])}`], holds: [pageHold(ref)] };
    },
  },
  {
    method: "PUT",
    path: /^\/api\/docs\/(.+)$/,
    aim: m => {
      const path = decodeURIComponent(m[1] ?? "");
      return { gesture: "edit", action: "edit doc", to: [`doc-editor:${path}`, `doc-editor:${path}.md`, ...docRow(path)], holds: holdDoc(path) };
    },
  },
  {
    method: "PATCH",
    path: /^\/api\/docs\/(.+)$/,
    aim: (m, { body }) => docMove(decodeURIComponent(m[1] ?? ""), stringOr(body["to"])),
  },
  {
    method: "PATCH",
    path: /^\/api\/docs-folder\/(.+)$/,
    aim: (m, { body }) => docMove(decodeURIComponent(m[1] ?? ""), stringOr(body["to"])),
  },
  {
    method: "POST",
    path: /^\/api\/docs-folder\/(.+)$/,
    aim: m => {
      const path = decodeURIComponent(m[1] ?? "");
      return { gesture: "create", action: "new folder", to: [`docs:folder:${path}`], into: [`docs:folder:${dirOf(path)}`, "docs:tree"], holds: ["docs"] };
    },
  },
];

function aimOf(method: string, path: string, seen: Seen) {
  const rule = RULES.find(r => r.method === method && r.path.test(path));
  const m = rule?.path.exec(path);
  return rule && m ? rule.aim(m, seen) : undefined;
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
    const aim = aimOf(req.method, path, seen);
    if (!aim) return;
    const cursor: Cursor = { type: "cursor", agent: agent.id, name: agent.name, ...aim, at: Date.now() };
    const msg = JSON.stringify(cursor);
    for (const ws of worldClients) ws.sendText(msg);
  } catch (error) {
    console.error("cursor event dropped:", error);
  }
}

const CANVAS_PATH = /^\/api\/canvas\/([^/]+)/;
const claimedCanvases = new Map<string, number>();
export const isCanvasClaimed = (file: string) => (claimedCanvases.get(file) ?? 0) > 0;

function claimCanvas(path: string) {
  const m = CANVAS_PATH.exec(path);
  if (!m) return;
  const file = canvasFile(m[1] ?? "");
  claimedCanvases.set(file, (claimedCanvases.get(file) ?? 0) + 1);
  return () => {
    const left = (claimedCanvases.get(file) ?? 1) - 1;
    if (left > 0) claimedCanvases.set(file, left);
    else claimedCanvases.delete(file);
  };
}

type Answer<S> = (req: Request, server: S) => Promise<Response | undefined>;

// constraint: world patches go out 100ms+ after a publish, so this event reaches the tab first and it can hold the change for the cursor
export const withCursors = <S>(answer: Answer<S>) => async (req: Request, server: S) => {
  const agent = sessions.get(req.headers.get("x-maxflow-from") ?? "");
  const isAction = agent !== undefined && req.method !== "GET" && RULES.some(r => r.method === req.method && r.path.test(new URL(req.url).pathname));
  const sent = isAction ? req.clone() : undefined;
  const unclaim = sent && worldClients.size > 0 ? claimCanvas(new URL(req.url).pathname) : undefined;
  let res: Response | undefined;
  try {
    res = await answer(req, server);
  } finally {
    unclaim?.();
  }
  if (!agent || !sent || res?.ok !== true || worldClients.size === 0) return res;
  void send(agent, req, sent, res.clone());
  return res;
};
