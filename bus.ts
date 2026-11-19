import { isRecord } from "./shared/guards";
import { appendStateText, readStateText } from "./state";

const LOG = "events.jsonl";
const KEEP = 5000;

export type Event = { seq: number; at: number; topic: string; data: unknown };

const isEvent = (value: unknown): value is Event =>
  isRecord(value) && typeof value["seq"] === "number" && typeof value["at"] === "number" && typeof value["topic"] === "string" && "data" in value;

const parseEvent = (line: string): unknown => JSON.parse(line);

const events: Event[] = (readStateText(LOG) ?? "").trim().split("\n").filter(Boolean).slice(-KEEP).map(parseEvent).filter(isEvent);
const latest = { seq: events.at(-1)?.seq ?? 0 };
const waiters = new Set<() => void>();

const escapeRegExp = (text: string) => text.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);

const segmentPattern = (segment: string) => (segment === "**" ? ".*" : segment.split("*").map(escapeRegExp).join("[^/]*"));

export function topicMatcher(glob: string) {
  const pattern = new RegExp(`^${glob.split("/").map(segmentPattern).join("/")}$`);
  return (topic: string) => pattern.test(topic);
}

export const onPublish = new Set<(ev: Event) => void>();

export function publish(topic: string, data: unknown) {
  latest.seq += 1;
  const ev = { seq: latest.seq, at: Date.now(), topic, data };
  events.push(ev);
  if (events.length > KEEP) events.shift();
  appendStateText(LOG, `${JSON.stringify(ev)}\n`);
  for (const wake of waiters) wake();
  for (const f of onPublish) f(ev);
  return ev;
}

export const latestSeq = () => latest.seq;

const nextPublishOrDeadline = async (deadline: number) =>
  new Promise<void>((resolve) => {
    const wake = () => {
      waiters.delete(wake);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(wake, deadline - Date.now());
    waiters.add(wake);
  });

export async function query(glob: string, afterSeq: number, waitMs: number) {
  const isMatch = topicMatcher(glob);
  const found = () => events.filter((e) => e.seq > afterSeq && isMatch(e.topic));
  let hits = found();
  const deadline = Date.now() + waitMs;
  while (hits.length === 0 && Date.now() < deadline) {
    await nextPublishOrDeadline(deadline);
    hits = found();
  }
  return hits;
}
