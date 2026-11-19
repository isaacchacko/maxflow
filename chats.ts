import { readdir, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, stringOr } from "./shared/guards";

const PROJECTS = join(homedir(), ".claude", "projects");
const SLICE = 64 * 1024;
const LOAD_BATCH = 64;

export type Chat = { id: string; title: string; prompt: string; cwd: string; mtime: number; size: number; live: boolean };
type Meta = Omit<Chat, "live">;

const cache = new Map<string, Meta>();

async function readSlice(path: string, size: number, end: "head" | "tail") {
  const fh = await open(path, "r");
  try {
    const len = Math.min(SLICE, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, end === "tail" ? size - len : 0);
    return buf.toString("utf8").split("\n");
  } finally {
    await fh.close();
  }
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const textPart: unknown = content.find((c) => isRecord(c) && c["type"] === "text");
  return isRecord(textPart) ? stringOr(textPart["text"]) : "";
}

function promptText(content: unknown): string {
  const text = contentText(content);
  return text.startsWith("<") ? "" : text.replaceAll(/\s+/g, " ").trim();
}

const isTypedPrompt = (rec: Record<string, unknown>) => rec["type"] === "user" && rec["isSidechain"] !== true && rec["isMeta"] !== true;
function messageContent(rec: Record<string, unknown>) {
  const message = rec["message"];
  return isRecord(message) ? message["content"] : undefined;
}

async function readCwdAndPrompt(path: string, size: number) {
  let cwd = "";
  let prompt = "";
  const lines = await readSlice(path, size, "head");
  for (const line of lines) {
    if (cwd !== "" && prompt !== "") break;
    const rec = line.startsWith("{") ? parseRecord(line) : undefined;
    if (rec === undefined) continue;
    cwd ||= stringOr(rec["cwd"]);
    if (prompt === "" && isTypedPrompt(rec)) prompt = promptText(messageContent(rec));
  }
  return { cwd, prompt };
}

async function readNewestTitles(path: string, size: number) {
  let customTitle = "";
  let aiTitle = "";
  const lines = await readSlice(path, size, "tail");
  for (const line of lines) {
    const rec = line.includes("-title") ? parseRecord(line) : undefined;
    if (rec?.["type"] === "custom-title") customTitle = stringOr(rec["customTitle"]);
    else if (rec?.["type"] === "ai-title") aiTitle = stringOr(rec["aiTitle"]);
  }
  return customTitle || aiTitle;
}

async function readMeta(path: string, id: string, mtime: number, size: number): Promise<Meta> {
  const { cwd, prompt } = await readCwdAndPrompt(path, size);
  const title = await readNewestTitles(path, size);
  return { id, cwd, prompt: prompt.slice(0, 300), title: title || prompt.slice(0, 80) || id, mtime, size };
}

async function liveSessionIds() {
  const out = await new Response(Bun.spawn(["ps", "-axo", "command"]).stdout).text();
  return new Set(out.matchAll(/claude.*?--(?:resume|session-id)[= ]([0-9a-f-]{36})/g).map((m) => m[1]));
}

async function jsonlFiles(dir: string) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readMetaOrNull(path: string, mtime: number, size: number) {
  try {
    return await readMeta(path, path.slice(path.lastIndexOf("/") + 1, -6), mtime, size);
  } catch {
    return null;
  }
}

async function loadMeta(path: string) {
  const st = await statOrNull(path);
  if (!st || st.size === 0) return null;
  const hit = cache.get(path);
  if (hit?.mtime === st.mtimeMs) return hit;
  const meta = await readMetaOrNull(path, st.mtimeMs, st.size);
  if (meta) cache.set(path, meta);
  return meta;
}

export async function listChats(): Promise<Chat[]> {
  const dirs = await readdir(PROJECTS);
  const files = (await Promise.all(dirs.map(async (d) => jsonlFiles(join(PROJECTS, d))))).flat();
  const metas: (Meta | null)[] = [];
  for (let i = 0; i < files.length; i += LOAD_BATCH) metas.push(...(await Promise.all(files.slice(i, i + LOAD_BATCH).map(loadMeta))));
  const live = await liveSessionIds();
  return metas
    .filter((m): m is Meta => m !== null && m.cwd !== "")
    .toSorted((a, b) => b.mtime - a.mtime)
    .map((m) => ({ ...m, live: live.has(m.id) }));
}

export async function findChat(id: string) {
  return (await listChats()).find((c) => c.id === id);
}
