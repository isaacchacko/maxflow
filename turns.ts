import type { BunFile } from "bun";
import { backgroundShells, transcriptTail } from "./background";
import { publish } from "./bus";
import { type ClaudeState, type Session, isAgent, isSentry, sessions } from "./sessions";
import { dispatch, inputBox, setArchived, setClaudeState, setWait, stopAgent, wake } from "./lifecycle";
import { tellDone } from "./waits";
import { completeHandoff } from "./handoffs";
import { patch } from "./patch";
import { isFilled, isRecord, stringOr } from "./shared/guards";

const SLEEP_AFTER_STOP_MS = 3000;
const PEER_TURN_KEEPS_DONE_MS = 10_000;
type TurnState = ClaudeState | "gone" | undefined;
const isTurnEnd = (was: TurnState, state: TurnState) => state === "idle" && (was === "working" || was === "waiting");
const hasInbox = (s: Session) => s.inbox.length > 0;
const isUserTurnWhileDone = (s: Session, was: TurnState, state: TurnState) =>
  state === "working" && was !== "working" && s.wait?.kind === "done" && Date.now() - (s.peerTurnAt ?? 0) > PEER_TURN_KEEPS_DONE_MS;
const isWaitingTurnEnd = (s: Session, was: TurnState, state: TurnState) =>
  isTurnEnd(was, state) && s.wait !== undefined && s.wait.kind !== "done" && s.archived !== true && !hasInbox(s);
function sleepOnWaitUnlessStopBlocked(s: Session) {
  const at = s.claude?.at;
  setTimeout(() => {
    if (!s.wait || s.wait.kind === "done" || s.archived === true || hasInbox(s) || s.claude?.state !== "idle" || s.claude.at !== at) return;
    setWait(s, { ...s.wait, awake: false });
    setArchived(s, true);
  }, SLEEP_AFTER_STOP_MS);
}
export function claudeStateChanged(s: Session, state: ClaudeState | "gone") {
  const was = s.claude?.state;
  setClaudeState(s, state);
  if (isTurnEnd(was, state) && completeHandoff(s) !== undefined) return;
  if (isUserTurnWhileDone(s, was, state)) setWait(s);
  else if (isWaitingTurnEnd(s, was, state)) sleepOnWaitUnlessStopBlocked(s);
  else if (state === "idle" && s.archived === true) void stopAgent(s);
  if (isTurnEnd(was, state) && isAgent(s) && !isSentry(s)) afterTurn(s);
  if (state === "working" && s.wait !== undefined && s.archived === true) wake(s);
}

export const RESYNC_MS = 30_000, IDLE_DONE_MS = 5 * 60_000;
const MISSED_STOP_MS = 60_000;
async function tailOf(file: BunFile, bytes: number) {
  try {
    return await file.slice(Math.max(0, file.size - bytes)).text();
  } catch {
    return "";
  }
}
async function turnOver(s: Session) {
  if (!isFilled(s.transcript)) return null;
  const file = Bun.file(s.transcript);
  const tail = await tailOf(file, 500_000);
  const end = tail.lastIndexOf('"subtype":"turn_duration"');
  if (end === -1) return null;
  const after = tail.slice(tail.indexOf("\n", end) + 1);
  return /"type":"(user|assistant|api-request)"/.test(after) ? null : { at: file.lastModified };
}
const isResyncable = (s: Session) =>
  isAgent(s) && !isSentry(s) && s.exitCode === null && !isFilled(s.asleep) && s.claudeUp !== false && !hasInbox(s);
const isIdleWithNoWait = (s: Session) =>
  s.claude?.state !== "working" && s.claude?.state !== "waiting" && s.wait === undefined && s.archived !== true;
async function autoDoneUnlessBackground(s: Session) {
  const { background } = await turnEnd(s);
  if (background || s.wait !== undefined) return;
  setWait(s, { kind: "done", ref: "", at: Date.now(), auto: true });
  publish(`claude-resync/${s.id}`, { session: s.id, idle: true });
  tellDone(s);
}
async function resyncOne(s: Session) {
  const over = await turnOver(s);
  if (!over) return;
  if (s.claude?.state === "working" && Date.now() - over.at > MISSED_STOP_MS) {
    publish(`claude-resync/${s.id}`, { session: s.id, was: "working", now: "idle" });
    claudeStateChanged(s, "idle");
    return;
  }
  if (isIdleWithNoWait(s) && Date.now() - over.at > IDLE_DONE_MS && (await inputBox(s))?.empty === true) await autoDoneUnlessBackground(s);
}
export async function resync() {
  for (const s of sessions.values()) if (isResyncable(s)) await resyncOne(s);
}

const isNewCutOff = (s: Session, cutOff: string | undefined): cutOff is string => isFilled(cutOff) && cutOff !== s.cutOff;
async function finishTurn(s: Session, at: number) {
  if (s.claude?.state !== "idle" || s.claude.at !== at || s.exitCode !== null || hasInbox(s)) return;
  const end = await turnEnd(s);
  if (isNewCutOff(s, end.cutOff)) {
    patch(s, { cutOff: end.cutOff });
    carryOn(s, at);
    return;
  }
  if (s.wait?.kind === "done") {
    setWait(s, { ...s.wait, at: Date.now() });
    tellDone(s);
    return;
  }
  if (s.wait !== undefined || s.archived === true || end.background) return;
  setWait(s, { kind: "done", ref: "", at: Date.now(), auto: true });
  tellDone(s);
}
function afterTurn(s: Session) {
  const at = s.claude?.at;
  if (at === undefined) return;
  setTimeout(() => {
    void finishTurn(s, at);
  }, SLEEP_AFTER_STOP_MS);
}
const SLEEP_CUT = /went to sleep mid-response|while your computer was asleep/;
type CutOffReading = "unreadable" | { cutOff: string | undefined };
type TranscriptEntry = { type?: unknown; message?: unknown; isApiErrorMessage?: unknown; uuid?: unknown };
function parsedLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
function assistantReplyText(entry: TranscriptEntry): string | undefined {
  type ReplyMessage = { content?: unknown };
  const message: ReplyMessage | undefined = isRecord(entry.message) ? entry.message : undefined;
  const content = message?.content;
  if (content === undefined || content === null) return "";
  if (!Array.isArray(content) || content.some((p) => p === null || p === undefined)) return undefined;
  return content.map((p: unknown) => partText(p)).join(" ");
}
function partText(p: unknown) {
  type ReplyPart = { text?: unknown };
  const part: ReplyPart | undefined = isRecord(p) ? p : undefined;
  return stringOr(part?.text);
}
function cutOffIn(line: string): CutOffReading {
  const parsed = parsedLine(line);
  const entry: TranscriptEntry | undefined = isRecord(parsed) ? parsed : undefined;
  if (entry?.type !== "assistant") return "unreadable";
  const text = assistantReplyText(entry);
  if (text === undefined) return "unreadable";
  const isSleepCut = entry.isApiErrorMessage === true && SLEEP_CUT.test(text);
  return { cutOff: isSleepCut && typeof entry.uuid === "string" ? entry.uuid : undefined };
}
async function turnEnd(s: Session) {
  if (!isFilled(s.transcript)) return { background: false };
  const tail = await transcriptTail(s.transcript);
  let cutOff: string | undefined;
  for (const line of tail.split("\n")) {
    if (!line.startsWith('{"') || !line.includes('"type":"assistant"')) continue;
    const reading = cutOffIn(line);
    if (reading !== "unreadable") cutOff = reading.cutOff;
  }
  return { cutOff, background: backgroundShells(tail).size > 0 };
}
const MAC_SLEEP_GAP_MS = 30_000;
const AWAKE_BEFORE_CARRYING_ON_MS = 20_000;
const clock = { tickAt: Date.now(), awakeSince: 0 };
setInterval(() => {
  if (Date.now() - clock.tickAt > MAC_SLEEP_GAP_MS) clock.awakeSince = Date.now();
  clock.tickAt = Date.now();
}, 5000);
function carryOn(s: Session, at: number) {
  const check = setInterval(() => {
    if (s.exitCode !== null || s.claude?.at !== at || s.claude.state !== "idle") {
      clearInterval(check);
      return;
    }
    if (Date.now() - clock.awakeSince < AWAKE_BEFORE_CARRYING_ON_MS || Date.now() - clock.tickAt > 10_000) return;
    clearInterval(check);
    publish(`turn-cut/${s.id}`, { session: s.id, reply: s.cutOff });
    dispatch({ to: [s], target: s.name, text: "[maxflow] your last turn was cut off by the Mac sleeping; carry on" });
  }, 5000);
}
