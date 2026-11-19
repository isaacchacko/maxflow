import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../shared/guards";
import { appendStateText, didClaimState, hasState, listState, readStateJson, removeState, stateDirectory, writeStateJson } from "../state";

const STATE_FILE = "approval-notified.json";
const BOARD_FILE = "review-board.json";
const HELD = "Held: tier 3, waiting on Isaac";
const CLAIMS_NAME = "approval-claims";
const MAX_BACKOFF_MS = 30 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, MAX_BACKOFF_MS];
const SEND_TIMEOUT_MS = 30_000;
const HOUR_MS = 3_600_000;
const DEFAULT_PER_HOUR = 6;
const LOGGED_KEPT = 1000;

export type Note = { pr: string; sha: string; title: string; url: string; tier: number; summary: string };
type Config = { url?: string; tokenFile?: string; repo?: string; perHour?: number; holdTier?: number };
type Endpoint = Config & { url: string; tokenFile: string };
type Standing = "waiting" | "moved" | "unknown";
type Sent = { queue: Note[]; sent: Record<string, number>; logged: string[]; failures: number; retryAt: number };

const isPartialSent = (value: unknown): value is Partial<Sent> => isRecord(value);
const isConfig = (value: unknown): value is Config => isRecord(value);

function readJson<T>(name: string, fallback: T, isWanted: (value: unknown) => value is T): T {
  const parsed = readStateJson(name);
  return isWanted(parsed) ? parsed : fallback;
}

const sent: Sent = { queue: [], sent: {}, logged: [], failures: 0, retryAt: 0, ...readJson(STATE_FILE, {}, isPartialSent) };
const save = () => {
  writeStateJson(STATE_FILE, sent);
};
const tag = (n: Note) => `${n.pr}@${n.sha}`;
const note = (line: string) => {
  appendStateText("approval-notify.log", `${new Date().toISOString()}  ${line}\n`);
};
const claimName = (n: Note) => tag(n).replaceAll(/[^\w@.-]/g, "_");
const claimFile = (n: Note) => join(CLAIMS_NAME, claimName(n));

function isClaimWon(n: Note) {
  stateDirectory(CLAIMS_NAME);
  return didClaimState(claimFile(n));
}

const sentLastHour = () => listState(CLAIMS_NAME).filter(({ modifiedAt }) => Date.now() - modifiedAt < HOUR_MS).length;
const wasSent = (n: Note) => sent.sent[tag(n)] !== undefined;

export const config = () => readJson("approval-notify.json", {}, isConfig);

export function enqueue(n: Note) {
  if (wasSent(n) || hasState(claimFile(n)) || sent.queue.some((q) => tag(q) === tag(n))) return;
  sent.queue = [...sent.queue.filter((q) => q.pr !== n.pr), n];
  save();
}

// constraint: the same POST as the user's `b` alias (~/Scripts/pr.zsh): {"pr": n}, bearer token read from tokenFile at send time, never kept
async function send(cfg: Endpoint, n: Note) {
  const token = readFileSync(cfg.tokenFile, "utf8").trim();
  const pr = Number(n.pr.split("#", 2)[1]);
  const res = await fetch(cfg.url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ pr }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return { ok: res.ok, detail: `${res.status} ${(await res.text()).slice(0, 300)}` };
}

async function sendSafely(cfg: Endpoint, n: Note) {
  try {
    return await send(cfg, n);
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}

function isAwaitingReviewAt(pr: unknown, sha: string) {
  return isRecord(pr) && pr["state"] === "OPEN" && pr["headRefOid"] === sha && pr["reviewDecision"] === "REVIEW_REQUIRED";
}

function standingOnGitHub(n: Note): Standing {
  const [repo = "", num = ""] = n.pr.split("#", 2);
  const r = Bun.spawnSync(["gh", "pr", "view", num, "--repo", repo, "--json", "state,headRefOid,reviewDecision"], { stderr: "pipe" });
  if (r.exitCode !== 0) return "unknown";
  const pr: unknown = JSON.parse(r.stdout.toString());
  return isAwaitingReviewAt(pr, n.sha) ? "waiting" : "moved";
}

function heldSection(held: Note[]) {
  const items = held.map((n) => ({ pr: n.pr.split("/", 2)[1], url: n.url, note: `review passed; ${n.title}` }));
  return items.length === 0 ? [] : [{ title: HELD, items }];
}

function showHeld(held: Note[]) {
  const parsed = readStateJson(BOARD_FILE);
  const board = isRecord(parsed) ? parsed : {};
  const sections: unknown = board["sections"];
  const list: unknown[] = Array.isArray(sections) ? sections : [];
  const rest = list.filter((section) => !(isRecord(section) && section["title"] === HELD));
  writeStateJson(BOARD_FILE, { ...board, sections: [...rest, ...heldSection(held)] });
}

const hasEndpoint = (cfg: Config): cfg is Endpoint => (cfg.url ?? "") !== "" && (cfg.tokenFile ?? "") !== "";
const isForRepo = (cfg: Config, n: Note) => (cfg.repo ?? "") === "" || n.pr.startsWith(`${(cfg.repo ?? "").toLowerCase()}#`);
const unqueue = (n: Note) => {
  sent.queue = sent.queue.filter((q) => q !== n);
};

function logUnsent() {
  const unlogged = sent.queue.filter((q) => !sent.logged.includes(tag(q)));
  for (const n of unlogged) {
    note(`no endpoint, queued: ${tag(n)} tier ${n.tier}`);
    sent.logged = [...sent.logged, tag(n)].slice(-LOGGED_KEPT);
  }
}

function backOff(n: Note, detail: string) {
  removeState(claimFile(n));
  sent.retryAt = Date.now() + (BACKOFF_MS[Math.min(sent.failures, BACKOFF_MS.length - 1)] ?? MAX_BACKOFF_MS);
  sent.failures += 1;
  note(`failed ${tag(n)}: ${detail}; retrying after ${new Date(sent.retryAt).toISOString()}`);
}

async function sendOne(cfg: Endpoint, n: Note): Promise<"next" | "stop"> {
  const standing = wasSent(n) ? "moved" : standingOnGitHub(n);
  if (standing === "unknown") return "next";
  if (standing === "moved") note(`dropped ${tag(n)}: already sent, or no longer open at this head waiting on a review`);
  if (standing === "moved" || !isClaimWon(n)) {
    unqueue(n);
    return "next";
  }
  const res = await sendSafely(cfg, n);
  if (!res.ok) {
    backOff(n, res.detail);
    return "stop";
  }
  sent.failures = 0;
  sent.sent[tag(n)] = Date.now();
  unqueue(n);
  note(`sent ${tag(n)} tier ${n.tier}: ${res.detail}`);
  return "next";
}

async function sendQueued(cfg: Endpoint, held: Note[]) {
  const sendable = sent.queue.filter((q) => !held.includes(q));
  for (const n of sendable) {
    if (sentLastHour() >= (cfg.perHour ?? DEFAULT_PER_HOUR) || (await sendOne(cfg, n)) === "stop") return;
  }
}

export async function flush(isCurrent: (n: Note) => boolean) {
  const cfg = config();
  sent.queue = sent.queue.filter((n) => isCurrent(n) && isForRepo(cfg, n));
  if (!hasEndpoint(cfg)) {
    logUnsent();
    save();
    return;
  }
  const held = sent.queue.filter((n) => cfg.holdTier !== undefined && n.tier >= cfg.holdTier);
  showHeld(held);
  if (Date.now() >= sent.retryAt) await sendQueued(cfg, held);
  save();
}
