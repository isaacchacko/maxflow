#!/usr/bin/env bun
// meta sentry's feed: runs beside the meta agent (sentries/meta.md) in its pane. Every 15 minutes it reads the part of each live
// agent's transcript it hasn't read yet, times its turns, tool calls and model replies, and notifies the agent of the ones over a
// threshold, with the full digests in meta-flagged.json. Exits with the agent.
import { existsSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const STATE_FILE = join(STATE_DIR, "meta-state.json");
const FLAGGED_FILE = join(STATE_DIR, "meta-flagged.json");
const INTERVAL_MS = Number(process.env.META_INTERVAL ?? 15 * 60_000);
const SLOW_TURN_MS = Number(process.env.META_SLOW_TURN_MS ?? 10 * 60_000);
const SLOW_TOOL_MS = Number(process.env.META_SLOW_TOOL_MS ?? 5 * 60_000);
const SLOW_MODEL_MS = Number(process.env.META_SLOW_MODEL_MS ?? 3 * 60_000);
const REPEATS = Number(process.env.META_REPEATS ?? 4);
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

type Session = { id: string; name: string; running: boolean; sentry: boolean; agent: boolean; status: string; transcript?: string };
type Open = { name: string; what: string; at: number };
type Mark = { offset: number; tools: Record<string, Open>; turnAt?: number; askedAt?: number };
type Digest = {
  id: string;
  title: string;
  turns: number[];
  toolCalls: number;
  toolMs: number;
  modelMs: number;
  openTurnMs?: number;
  slowTools: { tool: string; what: string; ms: number; running?: boolean }[];
  slowReplies: number[];
  waitingOnModelMs?: number;
  repeated: { what: string; times: number }[];
};

const load = <T>(path: string, empty: T): T => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : empty);
const marks = load<Record<string, Mark>>(STATE_FILE, {});
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };
const notify = (text: string) =>
  fetch(`${base}/api/sessions/${process.env.MAXFLOW_SESSION}/notify`, { method: "POST", headers: caller, body: JSON.stringify({ text: `[maxflow meta] ${text}` }) });
let since = Date.now() - INTERVAL_MS;

// The bytes appended since the last read, cut at the last full line.
function delta(path: string, mark: Mark) {
  const size = statSync(path).size;
  if (size < mark.offset) mark.offset = 0;
  const buf = Buffer.alloc(size - mark.offset);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, buf.length, mark.offset);
  closeSync(fd);
  const end = buf.lastIndexOf(10) + 1;
  mark.offset += end;
  return buf.subarray(0, end).toString("utf8").split("\n").filter(Boolean);
}

// Head and tail both, since a chain like "sed -i ... && <test suite>" hides its heavy part at the end.
function short(input: any) {
  const text = String(input?.command ?? input?.description ?? input?.file_path ?? input?.pattern ?? input?.url ?? JSON.stringify(input ?? "")).replace(/\s+/g, " ");
  return text.length <= 400 ? text : `${text.slice(0, 220)} … ${text.slice(-160)}`;
}

function digest(s: Session, mark: Mark, lines: string[], now: number): Digest {
  const d: Digest = { id: s.id, title: s.name, turns: [], toolCalls: 0, toolMs: 0, modelMs: 0, slowTools: [], slowReplies: [], repeated: [] };
  const counts = new Map<string, number>();
  for (const line of lines) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(e.timestamp);
    if (!at) continue;
    const recent = at >= since;
    // turn_duration is written for only some turns; the Stop hook's summary ends every one.
    if (e.type === "system" && (e.subtype === "stop_hook_summary" || e.subtype === "turn_duration")) {
      if (mark.turnAt !== undefined && recent) d.turns.push(at - mark.turnAt);
      mark.turnAt = undefined;
    } else if (e.type === "api-request" && e.querySource === "repl_main_thread") {
      mark.askedAt = at;
    } else if (e.type === "assistant" && !e.isSidechain) {
      if (mark.askedAt !== undefined && recent) {
        d.modelMs += at - mark.askedAt;
        if (at - mark.askedAt >= SLOW_MODEL_MS) d.slowReplies.push(at - mark.askedAt);
      }
      mark.askedAt = undefined;
      for (const c of e.message?.content ?? [])
        if (c.type === "tool_use") {
          const what = short(c.input);
          mark.tools[c.id] = { name: c.name, what, at };
          if (recent) counts.set(`${c.name}: ${what}`, (counts.get(`${c.name}: ${what}`) ?? 0) + 1);
        }
    } else if (e.type === "user" && !e.isSidechain) {
      const content = e.message?.content;
      if (!e.isMeta && (typeof content === "string" || content?.some((c: any) => c.type === "text"))) mark.turnAt = at;
      for (const c of Array.isArray(content) ? content : [])
        if (c.type === "tool_result" && mark.tools[c.tool_use_id]) {
          const t = mark.tools[c.tool_use_id];
          delete mark.tools[c.tool_use_id];
          if (recent) d.toolCalls++, (d.toolMs += at - t.at);
          if (recent && at - t.at >= SLOW_TOOL_MS) d.slowTools.push({ tool: t.name, what: t.what, ms: at - t.at });
        }
    }
  }
  // Only a working agent is still on its turn; an idle one with leftovers was interrupted, and a waiting one waits on the user.
  if (s.status !== "working") mark.tools = {}, (mark.turnAt = mark.askedAt = undefined);
  for (const t of Object.values(mark.tools)) if (now - t.at >= SLOW_TOOL_MS) d.slowTools.push({ tool: t.name, what: t.what, ms: now - t.at, running: true });
  if (mark.turnAt) d.openTurnMs = now - mark.turnAt;
  if (mark.askedAt) d.waitingOnModelMs = now - mark.askedAt;
  d.repeated = [...counts].filter(([, n]) => n >= REPEATS).map(([what, times]) => ({ what, times }));
  return d;
}

const isSlow = (d: Digest) =>
  d.turns.some((ms) => ms >= SLOW_TURN_MS) || (d.openTurnMs ?? 0) >= SLOW_TURN_MS || d.slowTools.length > 0 || d.slowReplies.length > 0 || (d.waitingOnModelMs ?? 0) >= SLOW_MODEL_MS || d.repeated.length > 0;

async function tick() {
  const now = Date.now();
  const sessions = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running && s.agent && !s.sentry && s.transcript);
  const live = new Set(sessions.map((s) => s.transcript!));
  for (const path of Object.keys(marks)) if (!live.has(path)) delete marks[path];
  const flagged: Digest[] = [];
  for (const s of sessions) {
    if (!existsSync(s.transcript!)) continue;
    // A transcript seen for the first time is read from its last 2MB; only lines inside the window count anyway.
    const mark = (marks[s.transcript!] ??= { offset: Math.max(0, statSync(s.transcript!).size - 2_000_000), tools: {} });
    const d = digest(s, mark, delta(s.transcript!, mark), now);
    if (isSlow(d)) flagged.push(d);
  }
  since = now;
  writeFileSync(STATE_FILE, JSON.stringify(marks));
  const stamp = new Date(now).toLocaleTimeString();
  console.log(`${stamp}  ${sessions.length} agents read, ${flagged.length} over a threshold`);
  if (!flagged.length) return;
  writeFileSync(FLAGGED_FILE, JSON.stringify({ at: now, read: sessions.length, flagged }, null, 2));
  const min = (ms: number) => `${(ms / 60_000).toFixed(0)}m`;
  const line = (d: Digest) =>
    [
      `${d.id} (${d.title})`,
      ...d.turns.filter((ms) => ms >= SLOW_TURN_MS).map((ms) => `turn ${min(ms)}`),
      d.openTurnMs && d.openTurnMs >= SLOW_TURN_MS && `turn running ${min(d.openTurnMs)}`,
      ...d.slowTools.map((t) => `${t.tool} ${min(t.ms)}${t.running ? " still running" : ""}: ${t.what.slice(0, 120)}`),
      d.slowReplies.length && `${d.slowReplies.length} slow model replies`,
      d.waitingOnModelMs && d.waitingOnModelMs >= SLOW_MODEL_MS && `waiting on the model ${min(d.waitingOnModelMs)}`,
      ...d.repeated.map((r) => `ran ${r.times}x: ${r.what.slice(0, 120)}`),
    ]
      .filter(Boolean)
      .join("; ");
  const machine = `${cpus().length} cores, load ${loadavg().map((n) => n.toFixed(1)).join(" ")}`;
  await notify(`${flagged.length} of ${sessions.length} agents over a threshold in the last window (${machine}); digests in ${FLAGGED_FILE}:\n${flagged.map((d) => `- ${line(d)}`).join("\n")}`);
}

console.log(`meta sentry: every ${INTERVAL_MS / 60_000}m reads each agent's new transcript lines; slow is a turn over ${SLOW_TURN_MS / 60_000}m, a tool over ${SLOW_TOOL_MS / 60_000}m, a reply over ${SLOW_MODEL_MS / 60_000}m, or a command run ${REPEATS}+ times`);
// Started with the server, so wait for it to answer before the first read.
while (!(await fetch(`${base}/api/sessions`).then((r) => r.ok, () => false))) await Bun.sleep(2_000);
for (;;) {
  try {
    await tick();
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
  if (process.ppid === 1) process.exit(0);
}
