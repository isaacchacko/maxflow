import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR = join(process.env.HOME!, ".maxflow");
const LOG = join(STATE_DIR, "events.jsonl");
const KEEP = 5000;

export type Event = { seq: number; at: number; topic: string; data: unknown };

mkdirSync(STATE_DIR, { recursive: true });
const events: Event[] = existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).slice(-KEEP).map((l) => JSON.parse(l))
  : [];
let seq = events.at(-1)?.seq ?? 0;
const waiters = new Set<() => void>();

// `*` matches one topic segment, `**` any number of them.
export function topicMatcher(glob: string) {
  const re = glob.split("/").map((seg) => (seg === "**" ? ".*" : seg.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))).join("/");
  return (topic: string) => new RegExp(`^${re}$`).test(topic);
}

export function publish(topic: string, data: unknown) {
  const ev = { seq: ++seq, at: Date.now(), topic, data };
  events.push(ev);
  if (events.length > KEEP) events.shift();
  appendFileSync(LOG, JSON.stringify(ev) + "\n");
  for (const wake of waiters) wake();
  return ev;
}

export const latestSeq = () => seq;

// Events after `after` on `glob`; with `wait`, blocks until one arrives or the wait runs out.
export async function query(glob: string, after: number, wait: number) {
  const matches = topicMatcher(glob);
  const found = () => events.filter((e) => e.seq > after && matches(e.topic));
  let hits = found();
  const deadline = Date.now() + wait;
  while (!hits.length && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const wake = () => (waiters.delete(wake), clearTimeout(timer), resolve());
      const timer = setTimeout(wake, deadline - Date.now());
      waiters.add(wake);
    });
    hits = found();
  }
  return hits;
}
