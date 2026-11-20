import { readStateText, writeStateJson } from "./state";
import { EXTERNAL_SEEN, externalSeen, externalSignal } from "./routing";
import { recordUserComment, shouldSeedUserComments } from "./events";
import { isRecord } from "./shared/guards";

const EVENT_LOG = "events.jsonl";
const EXTERNAL_BACKFILL_WINDOW_MS = 86_400_000;
const EXTERNAL_SEEN_KEPT = 5000;

type LoggedEvent = { seq: number; at: number; topic: string; data: unknown };
const isLoggedEvent = (value: unknown): value is LoggedEvent => isRecord(value) && typeof value["seq"] === "number" && typeof value["at"] === "number" && typeof value["topic"] === "string";

function eventLogLines(): string[] {
  const text = readStateText(EVENT_LOG);
  if (text === undefined) throw new Error(`no ${EVENT_LOG}`);
  return text.split("\n");
}

function replayExternalSignalsOfTheLastDay() {
  const since = Date.now() - EXTERNAL_BACKFILL_WINDOW_MS;
  for (const line of eventLogLines()) {
    if (!line.includes('"topic":"slack/') && !line.includes('"topic":"gh/')) continue;
    const e: unknown = JSON.parse(line);
    if (isLoggedEvent(e) && e.at >= since) externalSignal(e, false);
  }
  writeStateJson(EXTERNAL_SEEN, [...externalSeen].slice(-EXTERNAL_SEEN_KEPT));
}

export function backfillExternalSignals() {
  try {
    replayExternalSignalsOfTheLastDay();
  } catch (error) {
    console.error(`external backfill failed: ${String(error)}`);
  }
}

function recordHisCommentsFromTheWholeLog() {
  for (const line of readStateText(EVENT_LOG)?.split("\n") ?? []) {
    if (!line.includes('"who":"the user')) continue;
    const e: unknown = JSON.parse(line);
    if (isRecord(e) && typeof e["topic"] === "string" && typeof e["at"] === "number") recordUserComment(e["topic"].split("/").at(-1), e["data"], e["at"]);
  }
}

export function seedHisCommentsOnFirstBoot() {
  if (!shouldSeedUserComments) return;
  try {
    recordHisCommentsFromTheWholeLog();
  } catch {
    console.error("seeding his comments from the event log failed");
  }
}
