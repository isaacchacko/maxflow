import { publish } from "./bus";
import { CLI, DIR } from "./instance";
import { createSession, editTask } from "./lifecycle";
import type { Thread } from "./model";
import { newObjective, setRole } from "./objectives";
import { acceptTrust, handoff } from "./routing";
import { type Session, isSentry, sessions } from "./sessions";
import { readStateJson, writeStateJson } from "./state";
import { saveTasks, saveThreads, tasks, threads } from "./stores";
import { message } from "./threads";

export const SIZES = ["direct", "area", "fyi", "ignore"] as const;
export type Size = (typeof SIZES)[number];

type Handoff = NonNullable<Awaited<ReturnType<typeof handoff>>>;
const home = process.env["HOME"] ?? "/";

function startAgent(name: string, cwd: string, prompt: string) {
  const agent = createSession(name, ["claude", "--permission-mode", "bypassPermissions", prompt], cwd.replace(/^~(?=\/|$)/, home));
  void acceptTrust(agent);
  return agent;
}

const DIRECT_WORKERS_FILE = "direct-workers.json";
type DirectWorker = { seq: number; thread?: string; at: number };
const isDirectWorkerMap = (value: unknown): value is Record<string, DirectWorker> => typeof value === "object" && value !== null;
const directWorkers = new Map(Object.entries(readStateJson(DIRECT_WORKERS_FILE, isDirectWorkerMap) ?? {}));
const saveDirectWorkers = () => {
  writeStateJson(DIRECT_WORKERS_FILE, Object.fromEntries(directWorkers));
};

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
const todaysDigestTitle = () => `FYIs ${DAY_FORMAT.format(Date.now())}`;
const isBlank = (text: string | undefined): text is "" | undefined => text === undefined || text.trim() === "";
const withLink = (line: string, link: string | undefined) => (isBlank(link) ? line : `${line} ${link}`);
const openThread = (id: string | undefined) => threads.find((t) => t.id === id && t.mergedInto === undefined);

function todaysDigest() {
  const title = todaysDigestTitle();
  const found = threads.find((t) => t.title === title && t.objective === "" && t.mergedInto === undefined);
  if (found) return found;
  const made: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title, objective: "", routers: [], messages: [] };
  threads.push(made);
  return made;
}

function noteInDigest(line: string) {
  const digest = todaysDigest();
  digest.messages.push(message("maxflow", line));
  delete digest.resolved;
  return digest;
}

function noteInThread(about: Thread, line: string) {
  about.messages.push(message("maxflow", `FYI: ${line}`));
  return about;
}

export function noteFyi(line: string, aboutId?: string) {
  const about = openThread(aboutId);
  const noted = about ? noteInThread(about, line) : noteInDigest(line);
  saveThreads();
  publish(`thread/${noted.id}`, { thread: noted.id, fyi: true });
  return noted;
}

function dropTask(id: number | undefined, why: string) {
  const task = tasks.find((x) => x.id === id);
  if (!task || task.status === "done" || task.status === "dropped") return;
  if (typeof editTask(task, { status: "dropped", event: `why here: ${why}` }) !== "string") saveTasks();
}

function letGo(threadId: string | undefined, why: string) {
  const thread = openThread(threadId);
  if (!thread) return;
  Object.assign(thread, { resolved: { at: Date.now() } });
  Reflect.deleteProperty(thread, "signal");
  dropTask(thread.feed?.task, why);
  saveThreads();
  publish(`thread/${thread.id}`, { thread: thread.id, resolved: true });
}

const whereToAnswer = (h: Handoff) => (h.thread ? `answer him in thread ${h.thread.id}` : `answer him in a thread you open with \`${CLI} thread new '<title>' '<text>'\``);
const directBrief = (h: Handoff) =>
  `\n[maxflow] You are a direct worker: the funnel sized this as one concrete ask, so it has no objective, no router and no board task of its own. Do it, and ${whereToAnswer(h)}. If it turns out to need several pieces or more than a day, promote yourself with \`${CLI} promote '<objective title: the outcome, a few words>'\`: you become the router of a new objective that holds this thread. When it is done, run \`${CLI} wait done\`.`;

function attachToThread(thread: Thread, worker: Session) {
  Object.assign(thread, { routers: [worker.id], pending: { routers: [worker.id], since: Date.now() } });
  Reflect.deleteProperty(thread, "signal");
  Object.assign(worker, { handed: thread.id });
  const task = tasks.find((x) => x.id === thread.feed?.task);
  if (task && typeof editTask(task, { session: worker.id, status: "doing", event: `why here: sized as one ask, given to its own worker (${worker.id})` }) !== "string") saveTasks();
  saveThreads();
  publish(`thread/${thread.id}`, { thread: thread.id, pending: true });
}

type SizeBody = { size?: string; cwd?: string; name?: string; note?: string; about?: string };
const firstFilled = (...options: (string | undefined)[]) => options.find((x) => !isBlank(x))?.trim();

async function startDirect(seq: number, body: SizeBody) {
  const h = await handoff(seq);
  if (!h) return;
  const name = firstFilled(body.name, h.thread?.title) ?? `request ${String(seq)}`;
  const worker = startAgent(name.slice(0, 80), firstFilled(body.cwd) ?? home, h.text + directBrief(h));
  directWorkers.set(worker.id, { seq, at: Date.now(), ...(h.thread && { thread: h.thread.id }) });
  saveDirectWorkers();
  if (h.thread) attachToThread(h.thread, worker);
  return worker;
}

type SizeRecord = { seq: number; size: Size; by: "funnel" | "promote"; thread?: string; session?: string; noted?: string; objective?: string };
const recorded = (record: SizeRecord) => {
  publish(`signal-size/${String(record.seq)}`, record);
  return Response.json(record);
};

async function sizeDirect(record: SizeRecord, body: SizeBody) {
  const worker = await startDirect(record.seq, body);
  return worker ? recorded({ ...record, session: worker.id }) : new Response("no such signal", { status: 404 });
}

function sizeFyi(record: SizeRecord, body: SizeBody) {
  if (isBlank(body.note)) return new Response("note: the one line he should see", { status: 400 });
  const noted = noteFyi(withLink(body.note.trim(), openThread(record.thread)?.feed?.link), body.about);
  letGo(record.thread, "only an FYI, noted in the digest");
  return recorded({ ...record, noted: noted.id });
}

const isSize = (value: unknown): value is Size => SIZES.some((s) => s === value);

async function size(seq: number, body: SizeBody) {
  if (!isSize(body.size)) return new Response(`size: one of ${SIZES.join(", ")}`, { status: 400 });
  const thread = threads.find((t) => t.signal === seq);
  const record: SizeRecord = { seq, size: body.size, by: "funnel", ...(thread && { thread: thread.id }) };
  if (body.size === "direct") return sizeDirect(record, body);
  if (body.size === "fyi") return sizeFyi(record, body);
  if (body.size === "ignore") letGo(record.thread, "noise, nothing for him or an agent");
  return recorded(record);
}

function promote(s: Session, title: string | undefined) {
  if (s.role !== undefined) return new Response("only a direct worker promotes itself; it already has a role", { status: 409 });
  if (isBlank(title)) return new Response("title required", { status: 400 });
  const o = newObjective(title.trim(), s.cwd);
  setRole(s, { role: "router", objective: o.id, scope: "Whole objective" });
  for (const t of threads) if (t.routers.includes(s.id) && t.objective === "") t.objective = o.id;
  saveThreads();
  const was = directWorkers.get(s.id);
  if (was) publish(`signal-size/${String(was.seq)}`, { seq: was.seq, size: "area", by: "promote", objective: o.id, session: s.id, ...(was.thread !== undefined && { thread: was.thread }) });
  directWorkers.delete(s.id);
  saveDirectWorkers();
  return Response.json({ objective: o.id, router: s.id, brief: `${DIR}/agents/router.md` });
}

async function bodyOf<T extends object>(req: Request): Promise<Partial<T>> {
  try {
    const parsed: unknown = await req.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

async function noteSentryFyi(req: Request, from: Session | undefined) {
  if (!from || !isSentry(from)) return new Response("only a sentry notes FYIs", { status: 403 });
  const { text, link, about } = await bodyOf<{ text: string; link: string; about: string }>(req);
  if (isBlank(text)) return new Response("text required", { status: 400 });
  return Response.json({ thread: noteFyi(withLink(text.trim(), link), about).id }, { status: 201 });
}

async function promoteCaller(req: Request, from: Session | undefined) {
  if (!from) return new Response("promote works only from a maxflow agent", { status: 400 });
  return promote(from, (await bodyOf<{ title: string }>(req)).title);
}

export async function sizingRoute(req: Request, url: URL): Promise<Response | undefined> {
  if (req.method !== "POST") return;
  const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
  const sized = /^\/api\/signals\/(\d+)\/size$/.exec(url.pathname);
  if (sized) return size(Number(sized[1]), await bodyOf<SizeBody>(req));
  if (url.pathname === "/api/promote") return promoteCaller(req, from);
  if (url.pathname === "/api/fyi") return noteSentryFyi(req, from);
  return undefined;
}
