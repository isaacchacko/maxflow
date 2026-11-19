import { BASE as base } from "../instance";
import { isRecord } from "../shared/guards";
import { state } from "./inbox-state";

export const FETCH_MS = 30_000;
const caller = { "x-maxflow-from": process.env["MAXFLOW_SESSION"] ?? "" };

export const log = (line: string) => {
  console.log(`${new Date().toLocaleTimeString()}  ${line}`);
};
export const post = async (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: caller, body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_MS) });
export const run = (cmd: string[]) => {
  const result = Bun.spawnSync(cmd, { stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
};
export const shortened = (text: string, n: number) => {
  const oneLine = text.replaceAll(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
};
export const stringField = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};
export const dig = (value: unknown, keys: string[]): unknown => keys.reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), value);
export const repoAndNumber = (prKey: string) => prKey.split("/", 2)[1] ?? "";

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(FETCH_MS) });
  const body: unknown = await res.json();
  return body;
}

export type Task = { id: number; title: string; status: string; sessions: string[]; links: string[] };
const isTask = (value: unknown): value is Task => isRecord(value) && typeof value["id"] === "number" && typeof value["status"] === "string" && Array.isArray(value["links"]);
export const isOpen = (task?: Task) => task !== undefined && task.status !== "done" && task.status !== "dropped";

export async function getTasks() {
  const tasks = await getJson("/api/tasks");
  return Array.isArray(tasks) ? tasks.filter(isTask) : [];
}

export type FeedThread = { id: string; mergedInto?: string; resolved?: unknown };
const isFeedThread = (value: unknown): value is FeedThread => isRecord(value) && typeof value["id"] === "string";
export async function getThreads() {
  const threads = await getJson("/api/threads");
  return Array.isArray(threads) ? threads.filter(isFeedThread) : [];
}

type BoardOptions = { title?: string; status?: string };
const movedStatus = (task: Task | undefined, status: string | undefined) =>
  status === undefined || status === "" || task?.status === "doing" || task?.status === status ? undefined : status;

async function writeToBoard(task: Task | undefined, link: string, event: string, options: BoardOptions) {
  const status = movedStatus(task, options.status);
  return post(task ? `/api/tasks/${task.id}` : "/api/tasks", {
    ...(!task && { title: options.title }),
    ...(status !== undefined && { status }),
    link,
    event: status === undefined ? event : `why here: ${event}`,
  });
}

// constraint: no session is linked, or the server would move the task with that agent's waits, and a reviewer finishing doesn't mean he has.
export async function onBoard(key: string, link: string, event: string, options: BoardOptions) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === state.tasks[key] && isOpen(t)) ?? tasks.findLast((t) => isOpen(t) && t.links.includes(link));
  if (!task && (options.title === undefined || options.title === "")) return null;
  const res = await writeToBoard(task, link, event, options);
  if (!res.ok) {
    log(`board write failed for ${key}: ${await res.text()}`);
    return null;
  }
  const written: unknown = await res.json();
  const id = dig(written, ["id"]);
  if (typeof id !== "number") return null;
  state.tasks[key] = id;
  await post("/api/events", { topic: `inbox/${task ? "update" : "task"}`, data: { task: id, key, link, event } });
  log(`T-${id} ${task ? "updated" : "made"}: ${event}`);
  return id;
}

export async function closeTask(key: string, event: string) {
  const task = (await getTasks()).find((t) => t.id === state.tasks[key]);
  if (task && isOpen(task)) await post(`/api/tasks/${task.id}`, { status: "done", event: `why here: ${event}` });
}
