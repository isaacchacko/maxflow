import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { yarnEnv } from "./shared/legacy-maxflow";
import { isRecord } from "./shared/guards";
import { DIR } from "./instance";

export const PREVIEW_PREFIX = "pv-";
export const PREVIEW_CAP = 3;
export const PREVIEW_IDLE_MS = Number(yarnEnv("PREVIEW_IDLE_H") ?? 6) * 3_600_000;
const FIRST_PORT = 4960;
const PORTS = 20;
export const VERDICTS = ["ship", "changes", "discard"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_LABELS: Record<Verdict, string> = { ship: "Ship it", changes: "Needs changes", discard: "Discard" };

export type Preview = {
  name: string;
  branch: string;
  worktree: string;
  port: number;
  agent: string;
  what: string;
  tryThis: string;
  live: string;
  token: string;
  startedAt: number;
  seenAt: number;
  thread?: string;
  verdict?: { verdict: Verdict; note: string; at: number };
};

const LIVE_TABLES_KEPT = new Set(["threads", "tasks", "objectives", "names", "todos", "gh_status"]);

export const previewDir = (name: string) => join(homedir(), `.yarn-v2-${name}`);
const previewFile = (dir: string) => join(dir, "preview.json");
export const previewName = (branch: string) =>
  `${PREVIEW_PREFIX}${branch
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40)}`;

export const asPreview = (p: unknown) => (isRecord(p) && typeof p["name"] === "string" ? (p as Preview) : undefined);

export function readPreview(dir: string): Preview | undefined {
  try {
    const text = readFileSync(previewFile(dir), "utf8");
    return asPreview(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export const writePreview = (p: Preview) => {
  writeFileSync(previewFile(previewDir(p.name)), JSON.stringify(p, null, 2));
};

export function previews(): Preview[] {
  return readdirSync(homedir())
    .filter((d) => d.startsWith(`.yarn-v2-${PREVIEW_PREFIX}`))
    .flatMap((d) => readPreview(join(homedir(), d)) ?? []);
}

export function isServing(p: Preview) {
  try {
    const pid = readFileSync(join(previewDir(p.name), "server.pid"), "utf8");
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export const isPortTaken = (port: number) => Bun.spawnSync(["lsof", "-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN"]).exitCode === 0;

export function freePort(others: Preview[]): number | undefined {
  const claimed = new Set(others.map((p) => p.port));
  for (let port = FIRST_PORT; port < FIRST_PORT + PORTS; port++) if (!claimed.has(port) && !isPortTaken(port)) return port;
  return undefined;
}

const devSh = (args: string[]) => Bun.spawnSync(["sh", join(DIR, "dev.sh"), ...args], { stdout: "pipe", stderr: "pipe" });

// constraint: dev.sh stops a server only by its pid file, and only while that pid still carries the instance's tag
export const stopServer = (name: string) => devSh(["stop", name]);

export function endPreview(name: string) {
  if (!name.startsWith(PREVIEW_PREFIX)) throw new Error(`${name} is not a preview`);
  devSh(["reset", name]);
}

export type LiveSources = { db: string; uploads: string; timelines: string };

export function snapshotLiveWithoutSlackInboxesOrCredentials(live: LiveSources, dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const f of ["yarn.db", "yarn.db-wal", "yarn.db-shm"]) rmSync(join(dir, f), { force: true });
  const liveDb = new Database(live.db, { readonly: true });
  liveDb.run(`VACUUM INTO '${join(dir, "yarn.db").replaceAll("'", "''")}'`);
  liveDb.close();
  const copy = new Database(join(dir, "yarn.db"));
  const tables = copy.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  for (const { name } of tables) if (!LIVE_TABLES_KEPT.has(name)) copy.run(`DELETE FROM ${name}`);
  copy.run("VACUUM");
  copy.close();
  rmSync(join(dir, "timelines"), { recursive: true, force: true });
  if (existsSync(live.timelines)) cpSync(live.timelines, join(dir, "timelines"), { recursive: true });
  if (existsSync(live.uploads) && !existsSync(join(dir, "uploads"))) cloneTree(live.uploads, join(dir, "uploads"));
}

// constraint: uploads run to hundreds of MB; a copy-on-write clone costs no disk on APFS or a reflinking filesystem
function cloneTree(from: string, to: string) {
  const flags = process.platform === "darwin" ? ["-Rc"] : ["-R", "--reflink=auto"];
  if (Bun.spawnSync(["cp", ...flags, from, to]).exitCode !== 0) cpSync(from, to, { recursive: true });
}
