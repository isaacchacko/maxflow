#!/usr/bin/env bun
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ciStateOf, fetchSessions, readStatus, repoOf, run, type Pr } from "../gh";
import { BASE } from "../instance";
import { isRecord } from "../shared/guards";
import { appendStateText, hasState, readStateJson, stateDirectory, writeStateJson } from "../state";
import { compose, isCommentingOn, post, type Posted } from "./approval-comment";
import { config, enqueue, flush, type Note } from "./approval-notify";
import { runReview, type Lens, type LensReview, type Reviewing } from "./approval-review";
import { changesOf, isFastLane, isReviewableCode, signalsOf, tierOf, type FastLane, type Scored, type Signals } from "./approval-score";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("approval");

const STATE_FILE = "approval-state.json";
const OUT_NAME = "approval";
const OUT_DIR = stateDirectory(OUT_NAME);
const SCRATCH_DIR = join(tmpdir(), "maxflow-approval");
const WRITE_SWITCH = "approval-write";
const TICK_MS = Number(process.env["APPROVAL_TICK_MS"] ?? 2 * 60_000);
const MAX_REVIEWS = 2;
const DRAFT_RECHECK_MS = 30 * 60_000;
const MAX_ROUNDS = 3;
const NOTIFY_TIMEOUT_MS = 30_000;
const HIGH_COMPLEXITY = 15;
const COMPLEXITY_RISE = 5;
const LIZARD_FILE = 6;
const LIZARD_FUNCTION = 8;
const LIZARD_CCN = 1;
const CSV_CELL = /("[^"]*"|[^,]+)/g;

type Head = {
  sha: string; url: string; title: string; author: string; status: "queued" | "reviewing" | "done" | "skipped" | "failed";
  why?: string; tier?: number; reasons?: string[]; signals?: Signals; lenses?: string[]; reviews?: LensReview[];
  started?: number; finished?: number; handed?: number;
};
type State = { heads: Record<string, Head>; rounds: Record<string, number>; comments: Record<string, Posted> };
type QueueRow = { pr: string; stage: string; sessions: { id: string }[] };
type PrMeta = { isDraft: boolean; baseRefName: string; body: string | null };

const isPartialState = (value: unknown): value is Partial<State> => isRecord(value);
const isQueue = (value: unknown): value is QueueRow[] => Array.isArray(value) && value.every((q) => isRecord(q) && typeof q["pr"] === "string");
const isPrMeta = (value: unknown): value is PrMeta => isRecord(value) && typeof value["baseRefName"] === "string";

function readJson<T>(name: string, fallback: T, isWanted: (value: unknown) => value is T): T {
  const parsed = readStateJson(name);
  return isWanted(parsed) ? parsed : fallback;
}

const state: State = { heads: {}, rounds: {}, comments: {}, ...readJson(STATE_FILE, {}, isPartialState) };
const save = () => {
  writeStateJson(STATE_FILE, state);
};
const log = (line: string) => {
  console.log(`${new Date().toLocaleTimeString()}  ${line}`);
};
const me = run(["gh", "api", "user", "--jq", ".login"]);
const readQueue = () => readJson("review-queue.json", [], isQueue);
const shortSha = (h: Head) => h.sha.slice(0, 8);

function isAwaitingApproval(key: string, pr: Pr, drafts: Set<string>) {
  const ci = ciStateOf(pr);
  return pr.author?.login === me && pr.state === "OPEN" && pr.reviewDecision === "REVIEW_REQUIRED" && ci !== "FAILURE" && ci !== "ERROR" && !drafts.has(key);
}

function waiting() {
  const drafts = new Set(readQueue().filter((q) => q.stage === "draft").map((q) => q.pr));
  return Object.entries(readStatus()).filter(([key, { pr }]) => isAwaitingApproval(key, pr, drafts)).map(([key, { pr }]) => ({ key, pr }));
}

function cloneOf(repo: string) {
  const name = repo.split("/", 2)[1] ?? "";
  return [join(homedir(), name), join(homedir(), "Programs", name), join(homedir(), "app")].find((d) => existsSync(join(d, ".git")) && repoOf(d) === repo);
}

function lizardRow(row: string, sideDir: string): [string, number] {
  const cols = (row.match(CSV_CELL) ?? []).map((c) => c.replaceAll(/^"|"$/g, ""));
  return [`${(cols[LIZARD_FILE] ?? "").slice(sideDir.length + 1)}:${cols[LIZARD_FUNCTION] ?? ""}`, Number(cols[LIZARD_CCN])];
}

function complexityBySide(tmp: string, side: string) {
  const sideDir = join(tmp, side);
  const out = existsSync(sideDir) ? run(["uvx", "lizard", "--csv", sideDir]) : "";
  return new Map(out.split("\n").filter((row) => row !== "").map((row) => lizardRow(row, sideDir)));
}

function copySide(tmp: string, dir: string, { side, ref }: { side: "base" | "head"; ref: string }, paths: string[]) {
  for (const p of paths) {
    const text = run(["git", "-C", dir, "show", `${ref}:${p}`]);
    if (text === "") continue;
    mkdirSync(dirname(join(tmp, side, p)), { recursive: true });
    writeFileSync(join(tmp, side, p), text);
  }
}

const isComplexityJump = (n: number, was: number | undefined) => (n >= HIGH_COMPLEXITY && (was ?? 0) < HIGH_COMPLEXITY) || (was !== undefined && n - was >= COMPLEXITY_RISE);

function complexity(dir: string, base: string, paths: string[]) {
  const tmp = join(SCRATCH_DIR, "lizard", String(process.pid));
  rmSync(tmp, { recursive: true, force: true });
  copySide(tmp, dir, { side: "base", ref: base }, paths);
  copySide(tmp, dir, { side: "head", ref: "HEAD" }, paths);
  const before = complexityBySide(tmp, "base");
  const after = complexityBySide(tmp, "head");
  rmSync(tmp, { recursive: true, force: true });
  return [...after].filter(([fn, n]) => isComplexityJump(n, before.get(fn))).map(([fn, n]) => {
    const was = before.get(fn);
    return `${fn} ${was === undefined ? "new, " : `${was}→`}${n}`;
  });
}

function fastLane(clone: string, dir: string, ref: string, base: string): FastLane | null {
  const lane = join(SCRATCH_DIR, "fast-lane");
  mkdirSync(lane, { recursive: true });
  for (const f of ["classify.py", "policy.toml"]) {
    const text = run(["git", "-C", clone, "show", `${ref}:.github/fast-lane/${f}`]);
    if (text === "") return null;
    writeFileSync(join(lane, f), text);
  }
  try {
    const parsed: unknown = JSON.parse(run(["python3", "-I", join(lane, "classify.py"), "--base", base, "--head", "HEAD"], dir));
    return isFastLane(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function score(clone: string, dir: string, ref: string, base: string): Scored {
  const changes = changesOf(dir, base);
  const lane = fastLane(clone, dir, ref, base);
  const signals = signalsOf({ clone, ref, base, changes, lane, complexity: complexity(dir, base, changes.map((c) => c.path).filter(isReviewableCode)) });
  return { signals, ...tierOf(signals) };
}

const findings = (h: Head) => (h.reviews ?? []).flatMap((r) => r.comments).filter((c) => c.severity !== "nit");
const isPassed = (h: Head) => (h.reviews?.length ?? 0) > 0 && (h.reviews ?? []).every((r) => r.verdict !== "request_changes") && findings(h).length === 0;
const decision = (h: Head) => (isPassed(h) ? "passed: notify Liudvikas" : "findings: back to its agent");
const suggested = (suggestion: string | undefined, prefix: string, limit = Infinity) => ((suggestion ?? "") === "" ? "" : `${prefix}${(suggestion ?? "").slice(0, limit)}`);

function logEntry(key: string, h: Head) {
  const usd = (h.reviews ?? []).reduce((n, r) => n + r.usd, 0);
  return [
    `## ${key} @ ${shortSha(h)}: ${h.status === "done" ? decision(h) : h.status}`,
    `${h.url} "${h.title}" by ${h.author} · tier ${h.tier ?? "?"}: ${(h.reasons ?? [h.why ?? ""]).join("; ")} · $${usd.toFixed(2)} · ${new Date().toISOString()}`,
    ...(h.reviews ?? []).flatMap((r) => [
      `- **${r.lens}** ${r.verdict}: ${r.summary}`,
      ...r.comments.map((c) => `  - ${c.severity} ${c.path}:${c.line} ${c.body}${(c.suggestion ?? "") === "" ? "" : ` → \`${(c.suggestion ?? "").slice(0, 120)}\``}`),
    ]),
    "", "",
  ].join("\n");
}

function record(key: string, h: Head) {
  const prDir = key.replaceAll(/[/#]/g, "_");
  stateDirectory(join(OUT_NAME, prDir));
  writeStateJson(join(OUT_NAME, prDir, `${h.sha}.json`), h);
  appendStateText("approval-log.md", logEntry(key, h));
}

async function didNotify(id: string, text: string) {
  try {
    await fetch(`${BASE}/api/sessions/${id}/notify`, { method: "POST", body: JSON.stringify({ text }), signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

async function reviewSentryId() {
  try {
    return (await fetchSessions()).find((s) => s.name === "sentry:review")?.id ?? "";
  } catch {
    return "";
  }
}

function findingsAsk(h: Head, rounds: number) {
  const list = findings(h).map((c) => `- ${c.severity} ${c.path}:${c.line} ${c.body}${suggested(c.suggestion, "\n  suggestion: ")}`).join("\n");
  return `The approval sentry's review of ${h.url} at ${shortSha(h)} (tier ${String(h.tier)}, round ${rounds} of ${MAX_ROUNDS}) found these. Liudvikas is asked to approve it only once a head passes. Fix the real ones and push; the new head is reviewed again on its own. If one is wrong, leave it and say why in your commit message.\n${list}`;
}

async function handBack(key: string, h: Head) {
  const rounds = (state.rounds[key] ?? 0) + 1;
  state.rounds[key] = rounds;
  Object.assign(h, { handed: Date.now() });
  if (rounds > MAX_ROUNDS) {
    log(`${key}: findings again after ${MAX_ROUNDS} rounds; left for a human`);
    return;
  }
  const ask = findingsAsk(h, rounds);
  const owner = readQueue().find((q) => q.pr === key)?.sessions[0]?.id;
  const reviewSentry = await reviewSentryId();
  const to = owner ?? reviewSentry;
  const text = owner === undefined
    ? `[maxflow approval] ${h.url} has no session. Get these findings to its chat as in your job 1 (revive the chat that opened it, or start one on its branch), verbatim, and tell it to fix and push:\n\n${ask}`
    : `[maxflow approval] ${ask}`;
  if (to !== "") await didNotify(to, text);
  log(`${key}: findings (round ${rounds}) to ${owner ?? `the review sentry ${to === "" ? "(not found)" : to}`}`);
}

async function handBackAndSave(key: string, h: Head) {
  await handBack(key, h);
  save();
}

function prMeta(repo: string, n: string) {
  const parsed: unknown = JSON.parse(run(["gh", "pr", "view", n, "-R", repo, "--json", "isDraft,baseRefName,body"]) || "null");
  return isPrMeta(parsed) ? parsed : null;
}

function checkoutHead(clone: string, repo: string, n: string, sha: string) {
  const dir = join(homedir(), "Worktrees", `approval-${repo.split("/", 2)[1] ?? ""}-${n}`);
  const checkout = existsSync(dir) ? ["git", "-C", dir, "checkout", "-q", "--detach", sha] : ["git", "-C", clone, "worktree", "add", "-q", "--detach", dir, sha];
  run(checkout);
  return dir;
}

async function reviewInTurn(reviewing: Reviewing, lenses: Lens[], reviews: LensReview[]) {
  for (const lens of lenses) reviews.push(await runReview(reviewing, lens));
}

type Checkout = Pick<Reviewing, "dir" | "pr" | "body"> & { clone: string; ref: string };

async function reviewHead(key: string, h: Head, { dir, pr, body, clone, ref }: Checkout) {
  const base = run(["git", "-C", dir, "merge-base", ref, "HEAD"]);
  const scored = score(clone, dir, ref, base);
  const lenses: Lens[] = scored.tier >= 2 ? ["correctness", "design"] : ["full"];
  Object.assign(h, scored, { lenses });
  log(`${key}@${shortSha(h)}: tier ${scored.tier} (${scored.reasons.join("; ")}), ${lenses.length} review(s)`);
  save();
  const reviews: LensReview[] = [];
  Object.assign(h, { reviews });
  const ghlessDir = stateDirectory(join(OUT_NAME, "no-gh"));
  await reviewInTurn({ dir, pr, body, key, head: h, scored, ghlessDir }, lenses, reviews);
}

async function work(key: string, h: Head, pr: Pr | undefined): Promise<Head> {
  const [repo = "", n = ""] = key.split("#", 2);
  const clone = cloneOf(repo);
  if (clone === undefined) return Object.assign(h, { status: "skipped" as const, why: `no clone of ${repo}` });
  const meta = prMeta(repo, n);
  if (meta === null) return Object.assign(h, { status: "failed" as const, why: "gh pr view failed" });
  if (meta.isDraft) return Object.assign(h, { status: "skipped" as const, why: "draft", finished: Date.now() });
  const ref = `origin/${meta.baseRefName}`;
  run(["git", "-C", clone, "fetch", "-q", "origin", meta.baseRefName, `pull/${n}/head`]);
  const dir = checkoutHead(clone, repo, n, h.sha);
  if (run(["git", "-C", dir, "rev-parse", "HEAD"]) !== h.sha) return Object.assign(h, { status: "failed" as const, why: "worktree not at head" });
  try {
    await reviewHead(key, h, { dir, pr, body: meta.body ?? "", clone, ref });
    Object.assign(h, { status: "done", finished: Date.now() });
  } catch (error) {
    Object.assign(h, { status: "failed", why: String(error).slice(0, 300), finished: Date.now() });
  } finally {
    run(["git", "-C", clone, "worktree", "remove", "--force", dir]);
  }
  log(`${key}@${shortSha(h)}: ${h.status} ${h.status === "done" ? decision(h) : (h.why ?? "")}`);
  return h;
}

const commenting = new Set<string>();

function commentOutcome(posted: Posted | null, body: string | null) {
  if (posted) return `posted (${posted.id})`;
  return body === null ? "dropped" : "refused by GitHub";
}

async function comment(key: string, h: Head) {
  if (state.comments[key]?.sha === h.sha || commenting.has(key) || !isCommentingOn()) return;
  commenting.add(key);
  try {
    const body = await compose(key, h.title);
    const posted = body === null ? null : post(key, h.sha, body, state.comments[key]);
    state.comments[key] = posted ?? { ...(state.comments[key] ?? { id: 0, body: "" }), sha: h.sha };
    log(`${key}@${shortSha(h)}: comment ${commentOutcome(posted, body)}`);
    save();
  } finally {
    commenting.delete(key);
  }
}

const active = new Set<string>();

const isDraftRecheckDue = (h: Head | undefined) => h?.status === "skipped" && h.why === "draft" && Date.now() - (h.finished ?? 0) > DRAFT_RECHECK_MS;

function queueNewHeads() {
  for (const { key, pr } of waiting()) {
    const h = state.heads[key];
    if (active.has(key)) continue;
    if (h?.sha === pr.headRefOid && h.status !== "reviewing" && !isDraftRecheckDue(h)) continue;
    state.heads[key] = { sha: pr.headRefOid, url: pr.url, title: pr.title, author: pr.author?.login ?? "?", status: "queued", started: Date.now() };
  }
}

async function reviewInBackground(key: string, h: Head, pr: Pr | undefined) {
  try {
    const done = await work(key, h, pr);
    if (done.status !== "skipped" || done.why !== "draft") record(key, done);
  } finally {
    active.delete(key);
    save();
  }
}

function startQueued() {
  const queued = Object.entries(state.heads).filter(([k, h]) => h.status === "queued" && !active.has(k)).toSorted(([, a], [, b]) => (a.started ?? 0) - (b.started ?? 0));
  const status = readStatus();
  for (const [key, h] of queued) {
    if (active.size >= MAX_REVIEWS) break;
    active.add(key);
    h.status = "reviewing";
    void reviewInBackground(key, h, status[key]?.pr);
  }
}

const note = (key: string, h: Head): Note => ({
  pr: key, sha: h.sha, title: h.title, url: h.url, tier: h.tier ?? 0,
  summary: (h.reviews ?? []).map((r) => r.summary).join(" ").slice(0, 600),
});

function actOnReviewed(live: Map<string, string>) {
  for (const [key, h] of Object.entries(state.heads)) {
    if (h.status !== "done" || live.get(key) !== h.sha) continue;
    if (isPassed(h)) {
      enqueue(note(key, h));
      void comment(key, h);
    } else if (h.handed === undefined && hasState(WRITE_SWITCH)) {
      void handBackAndSave(key, h);
    }
  }
}

function tick() {
  queueNewHeads();
  startQueued();
  save();
  const live = new Map(waiting().map(({ key, pr }) => [key, pr.headRefOid]));
  actOnReviewed(live);
  void flush((n) => live.get(n.pr) === n.sha);
}

const mode = hasState(WRITE_SWITCH) ? "handing findings to the PRs' agents" : `shadow mode (touch ${join(dirname(OUT_DIR), WRITE_SWITCH)} to act)`;
log(`approval sentry up as ${me || "?"}; ${mode}; notifier ${(config().url ?? "") === "" ? "shadow (no url)" : "sending"}`);
tick();
setInterval(tick, TICK_MS);
