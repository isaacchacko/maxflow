import { isRecord } from "./shared/guards";
import { readStateText, threadsTable } from "./state";
import { dayKey } from "./stats-week";

export type BusEvent = { seq: number; at: number; topic: string; data: Record<string, unknown> };
type BusLog = { size: number; events: BusEvent[]; since: number; perDay: Map<string, number> };
type Message = { from: string; at: number };
export type StatsThread = { id: string; messages: Message[]; objective?: string; routers?: string[] };

const STATS_TOPICS = /"topic":"(signal\/isaac|signal-route\/|signal-size\/|slack\/|thread\/|ask\/|wait\/|gh\/[^"]*\/(merged|opened)"|ram\/killed|claude-resync\/|server\/start|sentry\/start)/;
const AT_FIELD = /"at":(\d+)/;
const HOUR_MS = 3_600_000;

const lastParsed: { log: BusLog | undefined } = { log: undefined };

function parseEvent(line: string): BusEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { seq, at, topic, data } = parsed;
  if (typeof seq !== "number" || typeof at !== "number" || typeof topic !== "string") return undefined;
  return { seq, at, topic, data: isRecord(data) ? data : {} };
}

function dayOfHour(days: Map<number, string>, at: number) {
  const hour = Math.floor(at / HOUR_MS);
  const known = days.get(hour);
  if (known !== undefined) return known;
  const day = dayKey(at);
  days.set(hour, day);
  return day;
}

function parseLog(text: string): BusLog {
  const events: BusEvent[] = [];
  let since = Infinity;
  const perDay = new Map<string, number>();
  const daysByHour = new Map<number, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const at = Number(AT_FIELD.exec(line)?.[1]);
    const isTimed = at > 0;
    if (since === Infinity && isTimed) since = at;
    if (isTimed) {
      const day = dayOfHour(daysByHour, at);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    const event = STATS_TOPICS.test(line) ? parseEvent(line) : undefined;
    if (event) events.push(event);
  }
  return { size: text.length, events, since, perDay };
}

export function busLog(): Omit<BusLog, "size"> {
  const text = readStateText("events.jsonl");
  if (text === undefined) return { events: [], since: Date.now(), perDay: new Map<string, number>() };
  if (lastParsed.log?.size === text.length) return lastParsed.log;
  lastParsed.log = parseLog(text);
  return lastParsed.log;
}

const isMessage = (m: unknown): m is Message => isRecord(m) && typeof m["from"] === "string" && typeof m["at"] === "number";
const isString = (value: unknown): value is string => typeof value === "string";

function statsThread(row: { id: string | number; messages: unknown[] }): StatsThread {
  const fields: Record<string, unknown> = { ...row };
  const { objective, routers } = fields;
  return {
    id: String(row.id),
    messages: row.messages.filter(isMessage),
    ...(typeof objective === "string" && { objective }),
    ...(Array.isArray(routers) && { routers: routers.filter(isString) }),
  };
}

export const statsThreads = () => threadsTable.read().map(statsThread);

export function noteResolution(resolvedAt: Map<string, number>, e: BusEvent) {
  const thread = typeof e.data["thread"] === "string" ? e.data["thread"] : "";
  const isResolved = Boolean(e.data["resolved"]);
  if (isResolved) resolvedAt.set(thread, e.at);
  else resolvedAt.delete(thread);
}

export const isResolution = (e: BusEvent) => e.topic.startsWith("thread/") && "resolved" in e.data;
