// Tells Liudvikas that one of the user's PRs passed its review, so he reviews and approves it himself, through the endpoint the
// user shares. $STATE_DIR/approval-notify.json holds {"url": "...", "perHour": 6, "headers": {...}}; with no url it is shadow mode
// and a notification is only logged. Each PR head is notified at most once; past perHour in the last hour the rest wait their turn.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../instance";

const CONFIG_FILE = join(STATE_DIR, "approval-notify.json");
const STATE_FILE = join(STATE_DIR, "approval-notified.json");
const LOG_FILE = join(STATE_DIR, "approval-notify.log");

export type Note = { pr: string; sha: string; title: string; url: string; tier: number; summary: string };
type Config = { url?: string; perHour?: number; headers?: Record<string, string> };
type Sent = { queue: Note[]; sent: Record<string, number>; logged: string[] };

const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const sent: Sent = { queue: [], sent: {}, logged: [], ...readJson<Partial<Sent>>(STATE_FILE, {}) };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(sent, null, 1));
const tag = (n: Note) => `${n.pr}@${n.sha}`;
const note = (line: string) => appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${line}\n`);

export const config = () => readJson<Config>(CONFIG_FILE, {});

export function enqueue(n: Note) {
  if (sent.sent[tag(n)] || sent.queue.some((q) => tag(q) === tag(n))) return;
  sent.queue = [...sent.queue.filter((q) => q.pr !== n.pr), n];
  save();
}

// What the endpoint gets, one POST per PR. Kept to these fields until its contract is known.
const payload = (n: Note) => ({ title: n.title, summary: n.summary, url: n.url, tier: n.tier, pr: n.pr, sha: n.sha });

// Sends what is queued, up to perHour in any hour, dropping a note whose PR moved on (`current` false: new head, approved, closed).
export async function flush(current: (n: Note) => boolean) {
  const { url, perHour = 6, headers = {} } = config();
  sent.queue = sent.queue.filter(current);
  if (!url) {
    for (const n of sent.queue.filter((q) => !sent.logged.includes(tag(q)))) {
      note(`shadow, would notify: ${JSON.stringify(payload(n))}`);
      sent.logged = [...sent.logged, tag(n)].slice(-1000);
    }
    return save();
  }
  const budget = perHour - Object.values(sent.sent).filter((at) => Date.now() - at < 3_600_000).length;
  for (const n of sent.queue.slice(0, Math.max(0, budget))) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload(n)) }).catch((e) => e as Error);
    if (res instanceof Error || !res.ok) {
      note(`failed ${tag(n)}: ${res instanceof Error ? res.message : `${res.status} ${(await res.text()).slice(0, 200)}`}`);
      break;
    }
    sent.sent[tag(n)] = Date.now();
    sent.queue = sent.queue.filter((q) => q !== n);
    note(`notified ${tag(n)}`);
  }
  save();
}
