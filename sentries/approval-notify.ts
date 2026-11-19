// Sends Liudvikas' approval endpoint each of the user's PRs that passed its review: the same POST as the user's `b` alias
// (~/Scripts/pr.zsh), {"pr": <n>} with the bearer token read from tokenFile at send time, never kept. $STATE_DIR/approval-notify.json
// holds {"url": "...", "tokenFile": "...", "repo": "dryft-ai/app", "perHour": 6}; with no url a pass is only logged. Each PR head is
// sent at most once, at most perHour in any hour; a failure is logged with its body and retried with backoff, never marked sent.
// A pass of tier holdTier or above stays queued, listed on the review board's PR-queue node, until the user lifts the hold.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../instance";

const CONFIG_FILE = join(STATE_DIR, "approval-notify.json");
const STATE_FILE = join(STATE_DIR, "approval-notified.json");
const BOARD_FILE = join(STATE_DIR, "review-board.json");
const HELD = "Held: tier 3, waiting on Isaac";
const LOG_FILE = join(STATE_DIR, "approval-notify.log");
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

export type Note = { pr: string; sha: string; title: string; url: string; tier: number; summary: string };
type Config = { url?: string; tokenFile?: string; repo?: string; perHour?: number; holdTier?: number };
type Sent = { queue: Note[]; sent: Record<string, number>; logged: string[]; failures: number; retryAt: number };

const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const sent: Sent = { queue: [], sent: {}, logged: [], failures: 0, retryAt: 0, ...readJson<Partial<Sent>>(STATE_FILE, {}) };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(sent, null, 1));
const tag = (n: Note) => `${n.pr}@${n.sha}`;
const note = (line: string) => appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${line}\n`);

export const config = () => readJson<Config>(CONFIG_FILE, {});

export function enqueue(n: Note) {
  if (sent.sent[tag(n)] || sent.queue.some((q) => tag(q) === tag(n))) return;
  sent.queue = [...sent.queue.filter((q) => q.pr !== n.pr), n];
  save();
}

async function send(cfg: Config, n: Note) {
  const token = readFileSync(cfg.tokenFile!, "utf8").trim();
  const res = await fetch(cfg.url!, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ pr: Number(n.pr.split("#")[1]) }),
  });
  return { ok: res.ok, detail: `${res.status} ${(await res.text()).slice(0, 300)}` };
}

// The held passes as one section of the review board, beside the sections the review sentry and its feed keep.
function showHeld(held: Note[]) {
  const board = existsSync(BOARD_FILE) ? JSON.parse(readFileSync(BOARD_FILE, "utf8")) : { sections: [] };
  const rest = (board.sections ?? []).filter((s: { title: string }) => s.title !== HELD);
  board.sections = [...rest, ...(held.length ? [{ title: HELD, items: held.map((n) => ({ pr: n.pr.split("/")[1], url: n.url, note: `review passed; ${n.title}` })) }] : [])];
  writeFileSync(`${BOARD_FILE}.tmp`, JSON.stringify(board, null, 2));
  renameSync(`${BOARD_FILE}.tmp`, BOARD_FILE);
}

// Sends what is queued, up to perHour in any hour, dropping a note whose PR moved on (`current` false: new head, approved, closed).
export async function flush(current: (n: Note) => boolean) {
  const cfg = config();
  sent.queue = sent.queue.filter((n) => current(n) && (!cfg.repo || n.pr.startsWith(`${cfg.repo.toLowerCase()}#`)));
  if (!cfg.url || !cfg.tokenFile) {
    for (const n of sent.queue.filter((q) => !sent.logged.includes(tag(q)))) {
      note(`no endpoint, queued: ${tag(n)} tier ${n.tier}`);
      sent.logged = [...sent.logged, tag(n)].slice(-1000);
    }
    return save();
  }
  const held = sent.queue.filter((n) => cfg.holdTier !== undefined && n.tier >= cfg.holdTier);
  showHeld(held);
  if (Date.now() < sent.retryAt) return save();
  const budget = (cfg.perHour ?? 6) - Object.values(sent.sent).filter((at) => Date.now() - at < 3_600_000).length;
  for (const n of sent.queue.filter((q) => !held.includes(q)).slice(0, Math.max(0, budget))) {
    const res = await send(cfg, n).catch((e) => ({ ok: false, detail: String(e) }));
    if (!res.ok) {
      sent.retryAt = Date.now() + BACKOFF_MS[Math.min(sent.failures, BACKOFF_MS.length - 1)];
      sent.failures++;
      note(`failed ${tag(n)}: ${res.detail}; retrying after ${new Date(sent.retryAt).toISOString()}`);
      break;
    }
    sent.failures = 0;
    sent.sent[tag(n)] = Date.now();
    sent.queue = sent.queue.filter((q) => q !== n);
    note(`sent ${tag(n)} tier ${n.tier}: ${res.detail}`);
  }
  save();
}
