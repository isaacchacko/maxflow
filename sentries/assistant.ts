#!/usr/bin/env bun
import { yarnEnv } from "../shared/legacy-maxflow";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE as base } from "../instance";
import { isRecord, stringOr } from "../shared/guards";
import { readStateJson, stateDirectory, writeStateJson } from "../state";
import { fetchTasks, lookUpPrsOfOpenTasksInOneQuery, taskTheServerFiledFromAsk, type Task } from "./assistant-tasks";
import { fullLinesAppendedSince, lastReply, parseEntry, usersOwnWordsUnlessStampedBySender, type TranscriptEntry } from "./transcript-read";
import { isStillTheFeed, replaceOlderFeed, waitForServer } from "./feed-process";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("assistant");

const STATE_FILE = "assistant-state.json";
const DIGEST_FILE = join(stateDirectory("."), "assistant-digest.json");
const READ_MS_SO_A_DIGEST_FOLLOWS_AN_ASK = Number(process.env["ASSISTANT_READ_MS"] ?? 60_000);
const INTERVAL_MS = Number(process.env["ASSISTANT_INTERVAL"] ?? 10 * 60_000);
const FIRST_READ_REACHES_BACK_MS = Number(process.env["ASSISTANT_BACKFILL_MS"] ?? 24 * 3_600_000);
const HOLD_SENTRY_PROMPT_FOR_ITS_TASK_MS = 3 * 60_000;
const NOTIFY_CHARS = 8000;
const TRANSCRIPT_TAIL_BYTES = 1_000_000;
const PROMPT_CHARS = 2000;
const REPLY_CHARS = 1200;
const EVENT_CHARS = 600;
const FETCH_MS = 30_000;
const MOVES_A_TASK = /^(ask\/[\w-]+|wait\/\w+|intent\/\w+|inbox\/\w+|task\/\d+|gh\/.+\/pr\/\d+\/(opened|merged|closed|review|ci|decision))$/;
const CANT_WAIT_FOR_NEXT_DIGEST = /^(ask|intent)\//;
const OWN_SESSION = yarnEnv("SESSION");

type Mark = { offset: number; reply?: string };
type Session = { id: string; name: string; sentry: boolean; agent: boolean; status: string; transcript?: string; asleep?: boolean; wait: { kind: string; ref: string } | null };
type ReadableSession = Session & { transcript: string };
type BusEvent = { seq: number; at: number; topic: string; data: unknown };
type Prompt = { at: string; session: string; title: string; sentry: boolean; text: string; task?: number };
type Reply = { session: string; title: string; status: string; wait: string | null; text: string };
type Pending = { prompts: Prompt[]; replies: Record<string, Reply>; events: string[]; urgent: boolean };
type State = { since: number; seq: number; marks: Record<string, Mark>; pending: Pending; digestAt: number };

const isSession = (value: unknown): value is Session =>
  isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && typeof value["status"] === "string";
const isReadable = (s: Session): s is ReadableSession => s.agent && typeof s.transcript === "string" && s.transcript !== "" && existsSync(s.transcript);
const isBusEvent = (value: unknown): value is BusEvent =>
  isRecord(value) && typeof value["seq"] === "number" && typeof value["at"] === "number" && typeof value["topic"] === "string";
const isPartialState = (value: unknown): value is Partial<State> => isRecord(value);

const kept = readStateJson(STATE_FILE, isPartialState);
const state: State = {
  since: Date.now() - FIRST_READ_REACHES_BACK_MS,
  seq: 0,
  marks: {},
  pending: { prompts: [], replies: {}, events: [], urgent: false },
  digestAt: 0,
  ...kept,
};
const { pending } = state;
const save = () => {
  writeStateJson(STATE_FILE, state);
};
const caller = { "x-yarn-from": OWN_SESSION ?? "" };
const getJson = async (path: string): Promise<unknown> => (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(FETCH_MS) })).json();
const notify = async (text: string) =>
  fetch(`${base}/api/sessions/${String(OWN_SESSION)}/notify`, {
    method: "POST",
    headers: caller,
    body: JSON.stringify({ text: `[yarn assistant] ${text}` }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
const isBusyEvenIfAsleepScreenSaysWorking = (s: Session) => s.status === "working" && s.asleep !== true;
const clip = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n)}…`);

function collectPrompt(s: Session, entry: TranscriptEntry | undefined) {
  if (entry?.["type"] !== "user") return;
  const at = Date.parse(stringOr(entry["timestamp"]));
  const isSinceLastRead = at >= state.since;
  if (!isSinceLastRead || s.id === OWN_SESSION) return;
  const words = usersOwnWordsUnlessStampedBySender(entry);
  if (words === null) return;
  pending.prompts.push({ at: new Date(at).toISOString(), session: s.id, title: s.name, sentry: s.sentry, text: clip(words, PROMPT_CHARS) });
  pending.urgent = true;
}

function readSession(s: ReadableSession) {
  const mark = (state.marks[s.transcript] ??= { offset: Math.max(0, statSync(s.transcript).size - TRANSCRIPT_TAIL_BYTES) });
  const { offset, lines } = fullLinesAppendedSince(s.transcript, mark.offset);
  mark.offset = offset;
  for (const line of lines) collectPrompt(s, parseEntry(line));
  const isOwnBookkeepingOrMidTurn = s.sentry || isBusyEvenIfAsleepScreenSaysWorking(s);
  const reply = isOwnBookkeepingOrMidTurn ? "" : lastReply(lines);
  if (reply === "" || reply === mark.reply) return;
  mark.reply = reply;
  pending.replies[s.id] = { session: s.id, title: s.name, status: s.status, wait: s.wait && `${s.wait.kind}:${s.wait.ref}`, text: clip(reply, REPLY_CHARS) };
}

function eventLine(e: BusEvent, nameOf: Map<string, string>, tasks: Task[]) {
  const data = isRecord(e.data) ? e.data : {};
  const session = stringOr(data["session"]);
  const who = session === "" ? "" : ` ${session} (${nameOf.get(session) ?? "?"})`;
  const what = clip(JSON.stringify(e.data), EVENT_CHARS);
  const request = data["request"];
  const filed = typeof request === "string" && e.topic.startsWith("intent/") ? taskTheServerFiledFromAsk(tasks, request) : undefined;
  return `${new Date(e.at).toISOString()} ${e.topic}${who} ${what}${filed === undefined || filed === 0 ? "" : ` (the server filed it as T-${filed})`}`;
}

async function readEvents(nameOf: Map<string, string>) {
  const events = await getJson(`/api/events?topic=**&after=${state.seq}`);
  const fresh = Array.isArray(events) ? events.filter(isBusEvent) : [];
  const tasks = fresh.some((e) => e.topic.startsWith("intent/")) ? await fetchTasks() : [];
  const movesInWindow = fresh.filter((ev) => MOVES_A_TASK.test(ev.topic) && ev.at >= state.since);
  for (const e of movesInWindow) {
    pending.events.push(eventLine(e, nameOf, tasks));
    if (CANT_WAIT_FOR_NEXT_DIGEST.test(e.topic)) pending.urgent = true;
  }
  state.seq = fresh.at(-1)?.seq ?? state.seq;
}

async function read() {
  const now = Date.now();
  const sessions = await getJson("/api/sessions");
  const readable = (Array.isArray(sessions) ? sessions.filter(isSession) : []).filter(isReadable);
  for (const s of readable) readSession(s);
  const live = new Set(readable.map((s) => s.transcript));
  state.marks = Object.fromEntries(Object.entries(state.marks).filter(([path]) => live.has(path)));
  await readEvents(new Map(readable.map((s) => [s.id, s.name])));
  state.since = now;
  save();
}

function digestText(prompts: Prompt[], replies: Reply[], events: string[]) {
  const sections: string[] = [];
  if (prompts.length > 0) {
    const taskNote = (p: Prompt) => (p.task === undefined || p.task === 0 ? "" : `, already task T-${p.task} (add to it, don't create another)`);
    sections.push(`The user's prompts:\n${prompts.map((p) => `- ${p.at} to ${p.session} (${p.title})${taskNote(p)}: ${JSON.stringify(p.text)}`).join("\n")}`);
  }
  if (replies.length > 0) {
    const waitNote = (r: Reply) => ((r.wait ?? "") === "" ? "" : `, waits on ${String(r.wait)}`);
    sections.push(`Where agents ended their turns:\n${replies.map((r) => `- ${r.session} (${r.title}) ${r.status}${waitNote(r)}: ${JSON.stringify(r.text)}`).join("\n")}`);
  }
  if (events.length > 0) sections.push(`Events:\n${events.map((e) => `- ${e}`).join("\n")}`);
  return sections.join("\n\n");
}

async function digest() {
  const now = Date.now();
  const replies = Object.values(pending.replies);
  const tasks = await fetchTasks();
  const unfiled = pending.prompts.filter((prompt) => prompt.task === undefined);
  for (const p of unfiled) {
    const task = taskTheServerFiledFromAsk(tasks, p.text);
    if (task !== undefined) p.task = task;
  }
  const held = pending.prompts.filter((p) => p.sentry && (p.task === undefined || p.task === 0) && now - Date.parse(p.at) < HOLD_SENTRY_PROMPT_FOR_ITS_TASK_MS);
  const prompts = pending.prompts.filter((p) => !held.includes(p));
  const { events } = pending;
  if (prompts.length === 0 && events.length === 0 && replies.length === 0) return;
  console.log(`${new Date(now).toLocaleTimeString()}  digest: ${prompts.length} prompts from the user, ${replies.length} replies, ${events.length} events`);
  writeFileSync(DIGEST_FILE, JSON.stringify({ at: now, prompts, replies, events }, null, 2));
  const text = digestText(prompts, replies, events);
  await notify(text.length <= NOTIFY_CHARS ? text : `${text.slice(0, NOTIFY_CHARS)}\n… cut here; the whole digest is in ${DIGEST_FILE}.`);
  Object.assign(pending, { prompts: held, replies: {}, events: [], urgent: held.length > 0 });
  state.digestAt = now;
  save();
}

console.log(`assistant sentry: reads every ${READ_MS_SO_A_DIGEST_FOLLOWS_AN_ASK / 1000}s; a digest within a minute of anything the user asked, else every ${INTERVAL_MS / 60_000}m`);
replaceOlderFeed("assistant");
await waitForServer();
const prsLookedUp = { at: 0 };
for (;;) {
  try {
    if (Date.now() - prsLookedUp.at >= INTERVAL_MS) {
      await lookUpPrsOfOpenTasksInOneQuery();
      prsLookedUp.at = Date.now();
    }
    await read();
    if (pending.urgent || Date.now() - state.digestAt >= INTERVAL_MS) await digest();
  } catch (error) {
    console.error(`${new Date().toLocaleTimeString()}  read failed:`, error);
  }
  await Bun.sleep(READ_MS_SO_A_DIGEST_FOLLOWS_AN_ASK);
  if (!isStillTheFeed("assistant")) process.exit(0);
}
