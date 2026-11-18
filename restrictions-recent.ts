import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { matches, type Call, type Restriction } from "./restrictions";

// Tool calls agents really made lately, read from the newest Claude Code transcripts, so a custom rule shows what it would have
// caught before he saves it. Only each transcript's tail is read, and the result is kept a minute.
const PROJECTS = join(homedir(), ".claude", "projects");
const FILES = 40;
const TAIL = 400_000;
export type Recent = Call & { at: string };

let cache: { at: number; calls: Recent[] } = { at: 0, calls: [] };
export function recentCalls(): Recent[] {
  if (Date.now() - cache.at < 60_000) return cache.calls;
  const files: { path: string; mtime: number }[] = [];
  try {
    for (const dir of readdirSync(PROJECTS))
      for (const f of readdirSync(join(PROJECTS, dir)))
        if (f.endsWith(".jsonl")) {
          const path = join(PROJECTS, dir, f);
          files.push({ path, mtime: statSync(path).mtimeMs });
        }
  } catch {}
  const calls: Recent[] = [];
  for (const { path } of files.sort((a, b) => b.mtime - a.mtime).slice(0, FILES)) {
    const size = statSync(path).size, start = Math.max(0, size - TAIL), buf = Buffer.alloc(size - start), fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, start), closeSync(fd);
    for (const line of buf.toString("utf8").split("\n").slice(start ? 1 : 0)) {
      if (!line.includes('"tool_use"')) continue;
      try {
        const e = JSON.parse(line) as { timestamp?: string; cwd?: string; message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] } };
        for (const c of e.message?.content ?? []) if (c.type === "tool_use" && c.name) calls.push({ tool: c.name, input: c.input, cwd: e.cwd, at: e.timestamp ?? "" });
      } catch {}
    }
  }
  cache = { at: Date.now(), calls: calls.sort((a, b) => b.at.localeCompare(a.at)) };
  return cache.calls;
}

/** What a rule's matchers would have caught among the recent calls: how many were looked at, and the newest few it catches. */
export function preview(match: Restriction["match"]) {
  const r = { id: "", action: "", label: "", mode: "ask", match } as Restriction;
  const calls = recentCalls();
  const caught = calls.filter((c) => matches(r, c));
  return {
    checked: calls.length,
    count: caught.length,
    caught: caught.slice(0, 8).map((c) => ({ tool: c.tool, text: c.tool === "Bash" ? String(c.input?.command ?? "").slice(0, 200) : c.tool, at: c.at })),
  };
}
