#!/usr/bin/env bun
import { yarnEnv } from "../shared/legacy-maxflow";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { backgroundShells, transcriptTail } from "../background";
import { BASE as base } from "../instance";
import { isRecord } from "../shared/guards";
import { readStateJson, stateDirectory, writeStateJson } from "../state";
import { isSlow, REPEATS, SLOW_MODEL_MS, SLOW_TOOL_MS, SLOW_TURN_MS, TranscriptWindow, type Digest, type Mark } from "./meta-digest";
import { waitForServer } from "./feed-process";
import { takeOver } from "./singleton";
import { fullLinesAppendedSince, lastLinesWithin, lastReply } from "./transcript-read";

if (import.meta.main) takeOver("meta");

const STATE_FILE = "meta-state.json";
const FLAGGED_FILE = join(stateDirectory("."), "meta-flagged.json");
const INTERVAL_MS = Number(process.env["META_INTERVAL"] ?? 15 * 60_000);
const IDLE_MS = Number(process.env["META_IDLE_MS"] ?? 10 * 60_000);
const FIRST_READ_TAIL_BYTES = 2_000_000;
const LAST_TEXT_TAIL_BYTES = 400_000;
const LAST_TEXT_CHARS = 600;
const SHOWN_CHARS = 120;
const FETCH_MS = 30_000;

type Session = {
  id: string; name: string; running: boolean; sentry: boolean; agent: boolean; status: string; transcript?: string;
  archived: boolean; activeAt: number; pending?: number; wait?: { kind: string; ref: string; at: number } | null;
  blocked?: { count: number; since: number } | null;
};
type ReadableSession = Session & { transcript: string };
type Idle = { id: string; title: string; idleMs: number; lastText: string };
type Blocked = { id: string; title: string; count: number; ms: number };
type Found = { flagged: Digest[]; idle: Idle[]; blocked: Blocked[] };

const isSession = (value: unknown): value is Session =>
  isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && typeof value["status"] === "string";
const isLiveAgent = (s: Session): s is ReadableSession => s.running && s.agent && !s.sentry && typeof s.transcript === "string" && s.transcript !== "";
const isMark = (value: unknown): value is Mark => isRecord(value) && typeof value["offset"] === "number" && isRecord(value["tools"]);

const kept = readStateJson(STATE_FILE, isRecord);
const store: { marks: Record<string, Mark> } = {
  marks: Object.fromEntries(Object.entries(kept ?? {}).filter((entry): entry is [string, Mark] => isMark(entry[1]))),
};
const readWindow = { since: Date.now() - INTERVAL_MS };
const caller = { "x-yarn-from": yarnEnv("SESSION") ?? "" };
const notify = async (text: string) =>
  fetch(`${base}/api/sessions/${String(yarnEnv("SESSION"))}/notify`, {
    method: "POST",
    headers: caller,
    body: JSON.stringify({ text: `[yarn meta] ${text}` }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
const min = (ms: number) => `${(ms / 60_000).toFixed(0)}m`;

function lastTextItEndedItsTurnOn(path: string) {
  const text = lastReply(lastLinesWithin(path, LAST_TEXT_TAIL_BYTES));
  return text.length > LAST_TEXT_CHARS ? `…${text.slice(-LAST_TEXT_CHARS)}` : text;
}

async function isIdleWithNothingToWakeIt(s: ReadableSession, mark: Mark, now: number) {
  const isIdleUnreported = s.status === "idle" && !s.archived && (s.wait ?? undefined) === undefined && (s.pending ?? 0) === 0 && now - s.activeAt >= IDLE_MS && mark.idleAt !== s.activeAt;
  return isIdleUnreported && backgroundShells(await transcriptTail(s.transcript)).size === 0;
}

async function readAgent(s: ReadableSession, now: number, found: Found) {
  const known = store.marks[s.transcript] ?? { offset: Math.max(0, statSync(s.transcript).size - FIRST_READ_TAIL_BYTES), tools: {} };
  const { offset, lines } = fullLinesAppendedSince(s.transcript, known.offset);
  const window = new TranscriptWindow(s.id, s.name, { ...known, offset }, readWindow.since);
  window.read(lines);
  const { digest, mark } = window.finish(s.status === "working", now);
  store.marks[s.transcript] = mark;
  if (isSlow(digest)) found.flagged.push(digest);
  if (await isIdleWithNothingToWakeIt(s, mark, now)) {
    mark.idleAt = s.activeAt;
    found.idle.push({ id: s.id, title: s.name, idleMs: now - s.activeAt, lastText: lastTextItEndedItsTurnOn(s.transcript) });
  }
  const blocked = s.blocked ?? undefined;
  if (blocked === undefined || mark.blockedAt === blocked.since) return;
  mark.blockedAt = blocked.since;
  found.blocked.push({ id: s.id, title: s.name, count: blocked.count, ms: now - blocked.since });
}

function digestLine(d: Digest) {
  const parts = [`${d.id} (${d.title})`, ...d.turns.filter((ms) => ms >= SLOW_TURN_MS).map((ms) => `turn ${min(ms)}`)];
  if ((d.openTurnMs ?? 0) >= SLOW_TURN_MS) parts.push(`turn running ${min(d.openTurnMs ?? 0)}`);
  parts.push(...d.slowTools.map((t) => `${t.tool} ${min(t.ms)}${t.running === true ? " still running" : ""}: ${t.what.slice(0, SHOWN_CHARS)}`));
  if (d.slowReplies.length > 0) parts.push(`${d.slowReplies.length} slow model replies`);
  if ((d.waitingOnModelMs ?? 0) >= SLOW_MODEL_MS) parts.push(`waiting on the model ${min(d.waitingOnModelMs ?? 0)}`);
  parts.push(...d.repeated.map((r) => `ran ${r.times}x: ${r.what.slice(0, SHOWN_CHARS)}`));
  return parts.join("; ");
}

function noticeText({ flagged, idle, blocked }: Found, read: number) {
  const sections: string[] = [];
  if (flagged.length > 0) {
    const machine = `${cpus().length} cores, load ${loadavg().map((n) => n.toFixed(1)).join(" ")}`;
    sections.push(`${flagged.length} of ${read} agents over a threshold in the last window (${machine}); digests in ${FLAGGED_FILE}:\n${flagged.map((d) => `- ${digestLine(d)}`).join("\n")}`);
  }
  if (idle.length > 0) {
    const lines = idle.map((i) => `- ${i.id} (${i.title}) idle ${min(i.idleMs)}: ${JSON.stringify(i.lastText.replaceAll(/\s+/g, " "))}`);
    sections.push(`${idle.length} agents idle with no declared wait (nothing will wake them); each one's last words:\n${lines.join("\n")}`);
  }
  if (blocked.length > 0) {
    const lines = blocked.map((b) => `- ${b.id} (${b.title}): ${b.count} waiting for ${min(b.ms)}`);
    sections.push(
      `${blocked.length} agents with messages queued behind a draft the user left in their prompt (the server clears an unchanged draft after 5m, 1m for his own request, and types it back):\n${lines.join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

async function liveAgents() {
  const sessions: unknown = await (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(FETCH_MS) })).json();
  return (Array.isArray(sessions) ? sessions.filter(isSession) : []).filter(isLiveAgent);
}

async function tick() {
  const now = Date.now();
  const sessions = await liveAgents();
  const live = new Set(sessions.map((s) => s.transcript));
  store.marks = Object.fromEntries(Object.entries(store.marks).filter(([path]) => live.has(path)));
  const found: Found = { flagged: [], idle: [], blocked: [] };
  const withTranscript = sessions.filter((agent) => existsSync(agent.transcript));
  for (const s of withTranscript) await readAgent(s, now, found);
  readWindow.since = now;
  writeStateJson(STATE_FILE, store.marks);
  const { flagged, idle, blocked } = found;
  console.log(`${new Date(now).toLocaleTimeString()}  ${sessions.length} agents read, ${flagged.length} over a threshold, ${idle.length} idle without a wait, ${blocked.length} with messages behind a draft`);
  if (flagged.length === 0 && idle.length === 0 && blocked.length === 0) return;
  writeFileSync(FLAGGED_FILE, JSON.stringify({ at: now, read: sessions.length, flagged, idle, blocked }, null, 2));
  await notify(noticeText(found, sessions.length));
}

console.log(
  `meta sentry: every ${INTERVAL_MS / 60_000}m reads each agent's new transcript lines; slow is a turn over ${SLOW_TURN_MS / 60_000}m, a tool over ${SLOW_TOOL_MS / 60_000}m, a reply over ${SLOW_MODEL_MS / 60_000}m, or a command run ${REPEATS}+ times`,
);
await waitForServer();
for (;;) {
  try {
    await tick();
  } catch (error) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, error);
  }
  await Bun.sleep(INTERVAL_MS);
  if (process.ppid === 1) process.exit(0);
}
