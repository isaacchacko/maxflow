import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { IS_LIVE } from "./instance";
import { stateDirectory } from "./state";

export const TIMELINES_DIR = process.env["MAXFLOW_TIMELINES"] ?? (IS_LIVE ? join(homedir(), "Timelines") : stateDirectory("timelines"));
export const TIMELINES_REMOTE = process.env["MAXFLOW_TIMELINES_REMOTE"] ?? (IS_LIVE ? "https://github.com/isaacchacko/timelines.git" : "");
export const NOW = "now.txt";
const AGENT_EMAIL = "timelines@maxflow.local";
const LOCK_RETRIES = 20;
const LOCK_RETRY_MS = 250;

export type TimelineEvent = { file: string; text: string };
export type Timeline = { path: string; events: number; latest?: string; now?: string };

export function git(args: string[], env: Record<string, string> = {}) {
  const run = Bun.spawnSync(["git", ...args], { cwd: TIMELINES_DIR, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args[0] ?? ""}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

const hasCommits = () => Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd: TIMELINES_DIR }).exitCode === 0;

export function ensureTimelines() {
  const isEmpty = !existsSync(TIMELINES_DIR) || readdirSync(TIMELINES_DIR).length === 0;
  if (isEmpty && TIMELINES_REMOTE !== "") {
    const clone = Bun.spawnSync(["git", "clone", "-q", TIMELINES_REMOTE, TIMELINES_DIR], { stdout: "pipe", stderr: "pipe" });
    if (clone.exitCode === 0) return;
  }
  mkdirSync(TIMELINES_DIR, { recursive: true });
  if (existsSync(join(TIMELINES_DIR, ".git"))) return;
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(TIMELINES_DIR, ".gitignore"), ".DS_Store\n");
  if (TIMELINES_REMOTE !== "") git(["remote", "add", "origin", TIMELINES_REMOTE]);
  didCommit("timelines created");
}

export const uncommitted = () =>
  git(["status", "--porcelain", "-z", "-uall"])
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));

const isLocked = (error: unknown) => String(error).includes("index.lock");

// constraint: every agent's CLI and the sentry commit here, so two at once meet git's index.lock and the later one waits its turn
export function didCommit(message: string, author = "maxflow") {
  for (let tries = 0; ; tries++) {
    try {
      git(["add", "-A", "--", "."]);
      if (hasCommits() && git(["diff", "--cached", "--name-only"]).trim() === "") return false;
      git(["commit", "-q", "-m", message], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: AGENT_EMAIL, GIT_COMMITTER_NAME: "maxflow", GIT_COMMITTER_EMAIL: AGENT_EMAIL });
      return true;
    } catch (error) {
      if (!isLocked(error) || tries >= LOCK_RETRIES) throw error;
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }
}

export function timelineDir(path: string) {
  const inside = relative(TIMELINES_DIR, resolve(TIMELINES_DIR, path));
  if (inside === "" || inside.startsWith("..") || /(^|\/)\.git(\/|$)/.test(inside)) throw new Error(`${path} is not a timeline under ${TIMELINES_DIR}`);
  return inside;
}

export const stampOf = (at: Date) => `${at.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
const safeTitle = (title: string) =>
  title
    .replaceAll(/[/\\:\0-\x1f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 100);

export function addEvent(path: string, title: string, text: string, at = new Date()) {
  const dir = timelineDir(path);
  mkdirSync(join(TIMELINES_DIR, dir), { recursive: true });
  const name = `${stampOf(at)} ${safeTitle(title) || "event"}`;
  let file = join(dir, `${name}.txt`);
  for (let n = 2; existsSync(join(TIMELINES_DIR, file)); n++) file = join(dir, `${name} ${String(n)}.txt`);
  writeFileSync(join(TIMELINES_DIR, file), text.endsWith("\n") ? text : `${text}\n`);
  return file;
}

export function setNow(path: string, text: string) {
  const dir = timelineDir(path);
  mkdirSync(join(TIMELINES_DIR, dir), { recursive: true });
  writeFileSync(join(TIMELINES_DIR, dir, NOW), text.endsWith("\n") ? text : `${text}\n`);
  return join(dir, NOW);
}

const isEventFile = (name: string) => name.endsWith(".txt") && name !== NOW;
// constraint: "<time> <title> 2.txt" must follow "<time> <title>.txt", and a plain sort puts the space before the dot
const byTime = (a: string, b: string) => {
  const [x, y] = [a.slice(0, -4), b.slice(0, -4)];
  return x < y ? -1 : x > y ? 1 : 0;
};
const readIfThere = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

function eventsIn(dir: string) {
  const full = join(TIMELINES_DIR, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isFile() && isEventFile(e.name))
    .map((e) => e.name)
    .sort(byTime);
}

export function readTimeline(path: string, last: number) {
  const dir = timelineDir(path);
  const names = eventsIn(dir);
  const events: TimelineEvent[] = names.slice(-last).map((name) => ({ file: join(dir, name), text: readFileSync(join(TIMELINES_DIR, dir, name), "utf8") }));
  return { path: dir, now: readIfThere(join(TIMELINES_DIR, dir, NOW)), events, total: names.length };
}

function walk(dir: string, visit: (dir: string, files: string[]) => void) {
  const entries = readdirSync(join(TIMELINES_DIR, dir), { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
  visit(
    dir,
    entries.filter((e) => e.isFile()).map((e) => e.name),
  );
  for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name), visit);
}

export function listTimelines(prefix = "") {
  const start = prefix === "" ? "" : timelineDir(prefix);
  if (!existsSync(join(TIMELINES_DIR, start)) || !statSync(join(TIMELINES_DIR, start)).isDirectory()) return [];
  const found: Timeline[] = [];
  walk(start, (dir, files) => {
    const events = files.filter(isEventFile).sort(byTime);
    if (events.length === 0 && !files.includes(NOW)) return;
    found.push({ path: dir, events: events.length, latest: events.at(-1), now: readIfThere(join(TIMELINES_DIR, dir, NOW)) });
  });
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export function findEvents(words: string[]) {
  const wanted = words.map((w) => w.toLowerCase());
  const hits: { file: string; line: string }[] = [];
  walk("", (dir, files) => {
    for (const name of files.filter((f) => f.endsWith(".txt"))) {
      const file = join(dir, name);
      const text = readFileSync(join(TIMELINES_DIR, file), "utf8");
      const haystack = `${file}\n${text}`.toLowerCase();
      if (!wanted.every((w) => haystack.includes(w))) continue;
      const line = text.split("\n").find((l) => wanted.some((w) => l.toLowerCase().includes(w))) ?? text.split("\n")[0] ?? "";
      hits.push({ file, line: line.trim() });
    }
  });
  return hits.sort((a, b) => a.file.localeCompare(b.file));
}
