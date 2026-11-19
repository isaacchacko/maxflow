import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { doesMatch, type Call, type Restriction } from "./restrictions";

const TRANSCRIPT_DIRS = join(homedir(), ".claude", "projects");
const NEWEST_TRANSCRIPTS = 40;
const TAIL_BYTES = 400_000;
const CACHE_MS = 60_000;
const PREVIEW_CAUGHT = 8;
const PREVIEW_TEXT = 200;
export type Recent = Call & { at: string };
type Transcript = { path: string; mtime: number };

const cache: { at: number; calls: Recent[] } = { at: 0, calls: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

function addTranscripts(found: Transcript[]) {
  for (const dir of readdirSync(TRANSCRIPT_DIRS)) {
    const dirPath = join(TRANSCRIPT_DIRS, dir);
    for (const name of readdirSync(dirPath)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dirPath, name);
      found.push({ path, mtime: statSync(path).mtimeMs });
    }
  }
}

function transcriptsUntilUnreadable(): Transcript[] {
  const found: Transcript[] = [];
  try {
    addTranscripts(found);
  } catch {
    return found;
  }
  return found;
}

function tailLines(path: string): string[] {
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  const lines = buf.toString("utf8").split("\n");
  return start > 0 ? lines.slice(1) : lines;
}

function toolCallsIn(entry: unknown): Recent[] {
  if (!isRecord(entry) || !isRecord(entry["message"])) return [];
  const content: unknown = entry["message"]["content"];
  const items: unknown[] = Array.isArray(content) ? content : [];
  const cwd = optionalString(entry["cwd"]);
  const at = optionalString(entry["timestamp"]) ?? "";
  const calls: Recent[] = [];
  for (const item of items) {
    if (!isRecord(item) || item["type"] !== "tool_use") continue;
    const tool = optionalString(item["name"]) ?? "";
    const input = item["input"];
    if (tool !== "") calls.push({ tool, ...(isRecord(input) && { input }), ...(cwd !== undefined && { cwd }), at });
  }
  return calls;
}

function toolCallsOnLine(line: string): Recent[] {
  if (!line.includes('"tool_use"')) return [];
  try {
    return toolCallsIn(JSON.parse(line));
  } catch {
    return [];
  }
}

export function recentCalls(): Recent[] {
  if (Date.now() - cache.at < CACHE_MS) return cache.calls;
  const newest = transcriptsUntilUnreadable()
    .toSorted((a, b) => b.mtime - a.mtime)
    .slice(0, NEWEST_TRANSCRIPTS);
  const calls = newest.flatMap(({ path }) => tailLines(path).flatMap((line) => toolCallsOnLine(line)));
  cache.at = Date.now();
  cache.calls = calls.toSorted((a, b) => b.at.localeCompare(a.at));
  return cache.calls;
}

const commandText = (call: Call) => {
  const command = call.input?.["command"];
  return typeof command === "string" ? command : "";
};

export function preview(match: Restriction["match"]) {
  const draft: Restriction = { id: "", action: "", label: "", mode: "ask", match };
  const calls = recentCalls();
  const caught = calls.filter((c) => doesMatch(draft, c));
  return {
    checked: calls.length,
    count: caught.length,
    caught: caught.slice(0, PREVIEW_CAUGHT).map((c) => ({ tool: c.tool, text: c.tool === "Bash" ? commandText(c).slice(0, PREVIEW_TEXT) : c.tool, at: c.at })),
  };
}
