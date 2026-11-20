import { existsSync, mkdirSync, watch } from "node:fs";
import { basename } from "node:path";
import { type Route, exactly, firstAnswer } from "./route-kit";
import { findEvents, listTimelines, readTimeline, TIMELINES_DIR } from "./timelines";
import { worldClients } from "./world";

const EVENT_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z (.*)\.txt$/;
const QUIET_MS = 500;
const ALL = Number.MAX_SAFE_INTEGER;

function sayTimelinesChanged() {
  const msg = JSON.stringify({ type: "timelines" });
  for (const ws of worldClients) ws.sendText(msg);
}

function watchTimelines() {
  if (!existsSync(TIMELINES_DIR)) mkdirSync(TIMELINES_DIR, { recursive: true });
  let pending: ReturnType<typeof setTimeout> | undefined;
  watch(TIMELINES_DIR, { recursive: true }, (_, file) => {
    if (file === null || /^\.git(\/|$)/.test(file)) return;
    clearTimeout(pending);
    pending = setTimeout(sayTimelinesChanged, QUIET_MS);
  });
}
watchTimelines();

async function authorsIn(dir: string) {
  const log = Bun.spawn(["git", "log", "--diff-filter=A", "--name-only", "--format=%x01%an", "--", dir], { cwd: TIMELINES_DIR, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(log.stdout).text();
  await log.exited;
  const authors = new Map<string, string>();
  for (const block of out.split("\u{1}").slice(1)) {
    const [author = "", ...files] = block.split("\n").filter((line) => line !== "");
    for (const file of files) if (!authors.has(file)) authors.set(file, author);
  }
  return authors;
}

function eventOf(file: string, text: string, authors: Map<string, string>) {
  const [, day = "", h = "", m = "", s = "", title = basename(file, ".txt")] = EVENT_NAME.exec(basename(file)) ?? [];
  const at = day === "" ? null : `${day}T${h}:${m}:${s}Z`;
  return { file, at, title, author: authors.get(file) ?? null, text };
}

async function events(url: URL) {
  const path = url.searchParams.get("path") ?? "";
  try {
    const t = readTimeline(path, ALL);
    const authors = await authorsIn(t.path);
    const newestFirst = t.events.toReversed().map((e) => eventOf(e.file, e.text, authors));
    return Response.json({ path: t.path, now: t.now ?? null, events: newestFirst });
  } catch (error) {
    return new Response(String(error), { status: 400 });
  }
}

function find(url: URL) {
  const words = (url.searchParams.get("q") ?? "").split(/\s+/).filter((w) => w !== "");
  return Response.json(words.length === 0 ? [] : findEvents(words));
}

const ROUTES: Route[] = [
  exactly("GET", "/api/timelines", () => Response.json({ dir: TIMELINES_DIR, timelines: listTimelines() })),
  exactly("GET", "/api/timelines/events", async (_req, url) => events(url)),
  exactly("GET", "/api/timelines/find", (_req, url) => find(url)),
];

export async function timelinesRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
