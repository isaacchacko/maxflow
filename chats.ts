import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";

const PROJECTS = join(process.env.HOME!, ".claude", "projects");
const SLICE = 64 * 1024;

export type Chat = { id: string; title: string; prompt: string; cwd: string; mtime: number; size: number; live: boolean };
type Meta = Omit<Chat, "live">;

const cache = new Map<string, Meta>();

async function readSlice(path: string, size: number, fromEnd: boolean) {
  const fh = await open(path, "r");
  try {
    const len = Math.min(SLICE, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString("utf8").split("\n");
  } finally {
    await fh.close();
  }
}

function promptText(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.find((c) => c?.type === "text")?.text ?? "" : "";
  return text.startsWith("<") ? "" : text.replace(/\s+/g, " ").trim();
}

async function readMeta(path: string, id: string, mtime: number, size: number): Promise<Meta> {
  let cwd = "", prompt = "", aiTitle = "", customTitle = "";
  for (const line of await readSlice(path, size, false)) {
    if (cwd && prompt) break;
    if (!line.startsWith("{")) continue;
    try {
      const rec = JSON.parse(line);
      cwd ||= rec.cwd ?? "";
      if (!prompt && rec.type === "user" && !rec.isSidechain && !rec.isMeta) prompt = promptText(rec.message?.content);
    } catch {}
  }
  // Titles get re-appended as the chat goes on, so the newest one is near the end.
  for (const line of size > SLICE ? await readSlice(path, size, true) : await readSlice(path, size, false)) {
    if (!line.includes("-title")) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === "custom-title") customTitle = rec.customTitle;
      if (rec.type === "ai-title") aiTitle = rec.aiTitle;
    } catch {}
  }
  return { id, cwd, prompt: prompt.slice(0, 300), title: customTitle || aiTitle || prompt.slice(0, 80) || id, mtime, size };
}

// Session ids held open by any running claude process (terminal, IDE, or maxflow).
async function liveIds() {
  const out = await new Response(Bun.spawn(["ps", "-axo", "command"]).stdout).text();
  return new Set([...out.matchAll(/claude.*?--(?:resume|session-id)[= ]([0-9a-f-]{36})/g)].map((m) => m[1]));
}

export async function listChats(): Promise<Chat[]> {
  const dirs = await readdir(PROJECTS);
  const files = (
    await Promise.all(
      dirs.map(async (d) => (await readdir(join(PROJECTS, d)).catch(() => [])).filter((f) => f.endsWith(".jsonl")).map((f) => join(PROJECTS, d, f))),
    )
  ).flat();
  const load = async (path: string) => {
    const st = await stat(path).catch(() => null);
    if (!st || st.size === 0) return null;
    const hit = cache.get(path);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const meta = await readMeta(path, path.slice(path.lastIndexOf("/") + 1, -6), st.mtimeMs, st.size).catch(() => null);
    if (meta) cache.set(path, meta);
    return meta;
  };
  const metas: (Meta | null)[] = [];
  for (let i = 0; i < files.length; i += 64) metas.push(...(await Promise.all(files.slice(i, i + 64).map(load))));
  const live = await liveIds();
  return metas
    .filter((m): m is Meta => !!m && !!m.cwd)
    .sort((a, b) => b.mtime - a.mtime)
    .map((m) => ({ ...m, live: live.has(m.id) }));
}

export async function findChat(id: string) {
  return (await listChats()).find((c) => c.id === id);
}
