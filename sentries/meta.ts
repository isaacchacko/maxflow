#!/usr/bin/env bun
// meta sentry: every 15 minutes reads the part of each live agent's transcript it hasn't read yet, times its turns,
// tool calls and model replies, and asks claude why the ones over a threshold are slow. It tells each slow agent why and
// how to fix it, remembers what it told them so a repeat is called out, and keeps the lessons every new agent starts with.
import { existsSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const STATE_FILE = join(STATE_DIR, "meta-state.json");
const REPORT_FILE = join(STATE_DIR, "meta-report.json");
const TOLD_FILE = join(STATE_DIR, "meta-told.json");
const LESSONS_FILE = join(STATE_DIR, "meta-lessons.json");
const MAX_LESSONS = 8;
const INTERVAL_MS = Number(process.env.META_INTERVAL ?? 15 * 60_000);
const SLOW_TURN_MS = Number(process.env.META_SLOW_TURN_MS ?? 10 * 60_000);
const SLOW_TOOL_MS = Number(process.env.META_SLOW_TOOL_MS ?? 5 * 60_000);
const SLOW_MODEL_MS = Number(process.env.META_SLOW_MODEL_MS ?? 3 * 60_000);
const REPEATS = Number(process.env.META_REPEATS ?? 4);
const MODEL = process.env.META_MODEL ?? "sonnet";
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

const SYSTEM = `You watch coding agents for slowness. Each input item is one agent's activity over the last window: its title, timed turns, total time in tools and in model replies with its tool call count, its slowest tool calls, its slowest model replies, a model request still unanswered, commands it repeated, and anything still running. The first line is the machine's load; a load far above its core count slows every agent at once, so name it as the cause when trivial commands are slow. Decide for each whether it is genuinely slow (stuck, looping, polling with sleeps, waiting on something that will never come, running a needlessly heavy command, an API that is slow to answer) or legitimately busy (a long build, CI it was told to wait on, a big honest task). 

You are also responsible for the agents getting better, not only for spotting them. Your fix is sent to the agent as a message, so write it to the agent: one concrete thing to do now or stop doing. An item's "toldBefore" lists what you already told that agent; if it is repeating the same mistake, say so in why and make the fix firmer. You keep the lessons every new agent is told when it starts, given as "lessons": return the list updated. Add a lesson only for a cause seen in several agents or one that came back after the agent was told; merge or reword rather than grow the list; keep at most ${MAX_LESSONS}, each one imperative sentence with no session ids. Return them unchanged when nothing new was learned.

Reply with only a JSON object: {"verdicts": [{"id": "<id>", "slow": true|false, "why": "<one sentence naming the cause>", "fix": "<one sentence to the agent, or empty>"}], "lessons": ["<lesson>", ...]}.`;

type Session = { id: string; name: string; running: boolean; sentry: boolean; agent: boolean; status: string; transcript?: string };
type Open = { name: string; what: string; at: number };
type Mark = { offset: number; tools: Record<string, Open>; turnAt?: number; askedAt?: number };
type Told = { at: number; why: string; fix: string };
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
  toldBefore?: Told[];
};

const load = <T>(path: string, empty: T): T => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : empty);
const marks = load<Record<string, Mark>>(STATE_FILE, {});
const told = load<Record<string, Told[]>>(TOLD_FILE, {});
let lessons = load<string[]>(LESSONS_FILE, []);
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: caller, body: JSON.stringify(body) });
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

async function judge(digests: Digest[]) {
  const min = (ms: number) => `${(ms / 60_000).toFixed(1)}m`;
  const machine = `Machine: ${cpus().length} cores, load average ${loadavg().map((n) => n.toFixed(1)).join(" ")} (1/5/15 min).`;
  const agents = JSON.stringify(
    digests.map((d) => ({
      ...d,
      turns: d.turns.map(min),
      toolMs: min(d.toolMs),
      modelMs: min(d.modelMs),
      openTurnMs: undefined,
      runningTurn: d.openTurnMs ? min(d.openTurnMs) : undefined,
      waitingOnModelMs: undefined,
      waitingOnModelFor: d.waitingOnModelMs ? min(d.waitingOnModelMs) : undefined,
      slowTools: d.slowTools.map((t) => ({ ...t, ms: undefined, took: min(t.ms) })),
      slowReplies: d.slowReplies.map(min),
      toldBefore: d.toldBefore?.map((t) => ({ ago: min(Date.now() - t.at), why: t.why, fix: t.fix })),
    })),
  );
  const input = `${machine}\nlessons: ${JSON.stringify(lessons)}\nagents: ${agents}`;
  const proc = Bun.spawn(
    ["claude", "-p", "--model", MODEL, "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", SYSTEM],
    { cwd: STATE_DIR, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`claude exited ${proc.exitCode}: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as { verdicts: { id: string; slow: boolean; why: string; fix: string }[]; lessons?: string[] };
}

async function tick() {
  const now = Date.now();
  const sessions = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running && s.agent && !s.sentry && s.transcript);
  const live = new Set(sessions.map((s) => s.transcript!));
  for (const path of Object.keys(marks)) if (!live.has(path)) delete marks[path];
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of Object.keys(told)) if (!ids.has(id)) delete told[id];
  const flagged: Digest[] = [];
  for (const s of sessions) {
    if (!existsSync(s.transcript!)) continue;
    // A transcript seen for the first time is read from its last 2MB; only lines inside the window count anyway.
    const mark = (marks[s.transcript!] ??= { offset: Math.max(0, statSync(s.transcript!).size - 2_000_000), tools: {} });
    const d = digest(s, mark, delta(s.transcript!, mark), now);
    if (isSlow(d)) flagged.push({ ...d, toldBefore: told[s.id] });
  }
  since = now;
  writeFileSync(STATE_FILE, JSON.stringify(marks));
  const stamp = new Date(now).toLocaleTimeString();
  if (!flagged.length) return console.log(`${stamp}  ${sessions.length} agents read, none slow`);
  const { verdicts, lessons: learned } = await judge(flagged);
  if (Array.isArray(learned)) {
    const next = learned.filter((l) => typeof l === "string" && l.trim()).slice(0, MAX_LESSONS);
    if (JSON.stringify(next) !== JSON.stringify(lessons)) console.log(`  lessons now:\n${next.map((l) => `    - ${l}`).join("\n")}`);
    writeFileSync(LESSONS_FILE, JSON.stringify((lessons = next), null, 2));
  }
  const slow = verdicts.filter((v) => v.slow).map((v) => ({ ...v, title: flagged.find((d) => d.id === v.id)?.title, digest: flagged.find((d) => d.id === v.id) }));
  writeFileSync(REPORT_FILE, JSON.stringify({ at: now, read: sessions.length, flagged: flagged.length, slow }, null, 2));
  console.log(`${stamp}  ${sessions.length} agents read, ${flagged.length} over a threshold, ${slow.length} slow`);
  for (const v of slow) {
    console.log(`  ${v.id}  ${v.title}\n    why: ${v.why}${v.fix ? `\n    fix: ${v.fix}` : ""}`);
    await post("/api/events", { topic: `meta/slow/${v.id}`, data: { why: v.why, fix: v.fix, digest: v.digest } });
    const times = (told[v.id]?.length ?? 0) + 1;
    const again = times > 1 ? ` I've flagged you ${times} times now; what you were told before didn't stick.` : "";
    await post(`/api/sessions/${v.id}/notify`, {
      text: `[maxflow meta] Your last 15 minutes ran slow: ${v.why}${v.fix ? ` Fix: ${v.fix}` : ""}${again} Change course now if it still applies, and if it's a habit rather than a one-off, save it as a feedback memory so you don't repeat it. (Automated notice from the meta sentry, not a request from the user.)`,
    });
    told[v.id] = [...(told[v.id] ?? []), { at: now, why: v.why, fix: v.fix }].slice(-3);
  }
  writeFileSync(TOLD_FILE, JSON.stringify(told));
}

console.log(`meta sentry: every ${INTERVAL_MS / 60_000}m reads each agent's new transcript lines; slow is a turn over ${SLOW_TURN_MS / 60_000}m, a tool over ${SLOW_TOOL_MS / 60_000}m, a reply over ${SLOW_MODEL_MS / 60_000}m, or a command run ${REPEATS}+ times; judged by ${MODEL}`);
for (;;) {
  try {
    await tick();
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
}
