#!/usr/bin/env bun
import { fetchSessions, isOwnComment, links, prNumber, repoOfKey, REVIEW_WATCH, writeWatches, type Link, type Session, type Watch } from "../gh";
import { BASE as base } from "../instance";
import { isRecord } from "../shared/guards";
import { readStateJson, writeStateJson } from "../state";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("review");

const QUEUE_FILE = "review-queue.json";
const BOARD_FILE = "review-board.json";
const INTERVAL_MS = Number(process.env["REVIEW_SENTRY_INTERVAL"] ?? 120_000);
const caller = { "x-maxflow-from": process.env["MAXFLOW_SESSION"] ?? "" };
const agent = process.env["MAXFLOW_SESSION"] ?? "";
const NOTIFY_TIMEOUT_MS = 30_000;
const EVENTS_GRACE_MS = 30_000;
const UI_LOOKUP_BATCH = 25;
const LOG_KEPT = 4;

type Pr = {
  number: number; url: string; title: string; body: string; isDraft: boolean; mergeable: string; reviewDecision: string | null; headRefName: string; headRefOid: string;
  createdAt: string; updatedAt: string; repository: { nameWithOwner: string; defaultBranchRef: { name: string } }; reviewRequests: { totalCount: number }; id: string;
  autoMergeRequest: object | null; mergeStateStatus: string; baseRefName: string; baseRef: { associatedPullRequests: { totalCount: number } } | null;
  latestReviews: { nodes: { state: string; submittedAt: string }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
type EventData = { pr: string; told: string[]; id?: string; who?: string | null; author?: string; state?: string; body?: string; url?: string; path?: string };
type Event = { seq: number; topic: string; data: EventData };
type UiNode = { id: string; files: { nodes: { path: string }[] } | null };
type PolledState = { state: string; decision: string };
type QueueEntry = { pr: string; url: string; title: string; stage: string; visual: boolean; ui: boolean; created: string; updated: string; sessions: { id: string; name: string | undefined }[] };
type LandingItem = { pr: string | undefined; url: string; note: string; why: string };

const QUERY = `query { search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) { nodes { ... on PullRequest {
 id number url title body isDraft mergeable reviewDecision headRefName createdAt updatedAt repository { nameWithOwner } reviewRequests(first: 1) { totalCount }
  autoMergeRequest { enabledAt } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;
// constraint: GitHub's GraphQL times out at 10s; the search plus the landing fields or files goes past it, so those are asked separately
const LANDING_FIELDS = `id number url title body isDraft mergeable reviewDecision headRefName headRefOid mergeStateStatus baseRefName
  repository { nameWithOwner defaultBranchRef { name } } autoMergeRequest { enabledAt } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  baseRef { associatedPullRequests(states: MERGED, first: 1) { totalCount } } latestReviews(first: 20) { nodes { state submittedAt } }`;
const UI_FILE = /frontend\/.*\.(tsx|css)$/;
const UI_TEST_FILE = /\.(test|stories)\.tsx$/;
const LANDING = "Approved, not merged (the feed is landing these)";
const ESCALATE_MS = 30 * 60_000;
const STUCK_IDLE_MS = 60_000;
const NEVER_MERGE = /never[- ]merge|do not merge|don'?t merge|not for merge|^one-off/i;

const isPr = (value: unknown): value is Pr => isRecord(value) && typeof value["number"] === "number";
const isUiNode = (value: unknown): value is UiNode => isRecord(value) && typeof value["id"] === "string";
const isPolledStates = (value: unknown): value is Record<string, PolledState> => isRecord(value);
const isEvent = (value: unknown): value is Event => isRecord(value) && typeof value["seq"] === "number" && typeof value["topic"] === "string" && isRecord(value["data"]);

function pathIn(stdout: string, path: string[]): unknown {
  let at: unknown = JSON.parse(stdout);
  for (const key of path) {
    if (!isRecord(at)) throw new TypeError(`GitHub's answer has no ${path.join(".")}`);
    at = at[key];
  }
  return at;
}

function listAt(stdout: string, path: string[]): unknown[] {
  const found = pathIn(stdout, path);
  if (!Array.isArray(found)) throw new TypeError(`GitHub's answer has no list at ${path.join(".")}`);
  return found;
}

const keyOf = (pr: Pr) => `${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase();
const label = (key: string) => key.split("/", 2)[1];
const ciOf = (pr: Pr) => pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? "";
const isCiFailing = (ci: string) => ci === "FAILURE" || ci === "ERROR";
const isMergeable = (pr: Pr) => pr.reviewDecision === "APPROVED" && !pr.isDraft && !NEVER_MERGE.test(pr.title) && !NEVER_MERGE.test(pr.body);

function polledApprovedKeys(): string[] {
  const polled = readStateJson("gh-state.json");
  return isPolledStates(polled) ? Object.entries(polled).filter(([, p]) => p.state === "OPEN" && p.decision === "APPROVED").map(([key]) => key) : [];
}

function landingLookup(repo: string, keys: string[]): Pr[] {
  const [owner, name] = repo.split("/", 2);
  const parts = keys.map((k) => `n${prNumber(k)}: pullRequest(number: ${prNumber(k)}) { ${LANDING_FIELDS} }`).join("\n");
  const r = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=query { r: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${parts} } }`], { stderr: "pipe" });
  if (r.exitCode !== 0) {
    console.error(`${new Date().toLocaleTimeString()}  landing lookup failed for ${repo}: ${r.stderr.toString().trim().split("\n", 1)[0] ?? ""}`);
    return [];
  }
  const found = pathIn(r.stdout.toString(), ["data", "r"]);
  return isRecord(found) ? Object.values(found).filter(isPr) : [];
}

function approvedPrs(mine: Pr[]): Pr[] {
  const keys = new Set([...mine.filter((pr) => pr.reviewDecision === "APPROVED").map(keyOf), ...polledApprovedKeys()]);
  const byRepo = Map.groupBy([...keys], repoOfKey);
  const prs: Pr[] = [];
  for (const [repo, ks] of byRepo) prs.push(...landingLookup(repo, ks));
  return prs.filter(isMergeable);
}

const uiOf = new Map<string, boolean>();
const touchesUi = (n: UiNode) => n.files?.nodes.some((f) => UI_FILE.test(f.path) && !UI_TEST_FILE.test(f.path)) ?? false;

function lookUpUi(prs: Pr[]) {
  const ids = prs.map((pr) => pr.id).filter((id) => !uiOf.has(id));
  for (let i = 0; i < ids.length; i += UI_LOOKUP_BATCH) {
    const q = `query { nodes(ids: ${JSON.stringify(ids.slice(i, i + UI_LOOKUP_BATCH))}) { ... on PullRequest { id files(first: 100) { nodes { path } } } } }`;
    const r = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${q}`], { stderr: "pipe" });
    if (r.exitCode !== 0) continue;
    const nodes = listAt(r.stdout.toString(), ["data", "nodes"]).filter(isUiNode);
    for (const n of nodes) uiOf.set(n.id, touchesUi(n));
  }
}

function openPrs(): Pr[] {
  const r = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${QUERY}`], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim());
  return listAt(r.stdout.toString(), ["data", "search", "nodes"]).filter(isPr);
}

function approvedStage(pr: Pr) {
  return pr.autoMergeRequest ? "merging" : "approved";
}

function stage(pr: Pr) {
  const ci = ciOf(pr);
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflict";
  if (isCiFailing(ci)) return "ci failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (ci !== "" && ci !== "SUCCESS") return "ci running";
  if (pr.reviewDecision === "APPROVED") return approvedStage(pr);
  return pr.reviewRequests.totalCount > 0 ? "in review" : "needs reviewer";
}

async function tellSession(id: string, text: string) {
  return fetch(`${base}/api/sessions/${id}/notify`, { method: "POST", headers: caller, body: JSON.stringify({ text: `[maxflow review] ${text}` }), signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
}

async function notify(text: string) {
  return tellSession(agent, text);
}

const stages = new Map<string, string>();
const titles = new Map<string, string>();
const landingLog = new Map<string, string[]>();
const blocked = new Set<string>();
const idleHoldingSince = new Map<string, number>();
const woken = new Set<string>();
const escalated = new Set<string>();

function refill<K, V>(map: Map<K, V>, entries: [K, V][]) {
  map.clear();
  for (const [k, v] of entries) map.set(k, v);
}

function gh(args: string[]) {
  const r = Bun.spawnSync(["gh", ...args], { stderr: "pipe", stdout: "pipe" });
  return { ok: r.exitCode === 0, err: r.stderr.toString().trim().split("\n", 1)[0] ?? "" };
}

function logAction(key: string, what: string) {
  const log = landingLog.get(key) ?? [];
  landingLog.set(key, log);
  if (log[0]?.endsWith(` ${what}`) === true) return;
  log.unshift(`${new Date().toTimeString().slice(0, 5)} ${what}`);
  log.splice(LOG_KEPT);
  console.log(`${new Date().toLocaleTimeString()}  ${key}  ${what}`);
}

const isUnreachable = (id: string) => blocked.has(id) || Date.now() - (idleHoldingSince.get(id) ?? Date.now()) > STUCK_IDLE_MS;

async function wake(pr: Pr, owners: string[], problem: string) {
  const key = keyOf(pr);
  const tag = `${key} ${problem} ${pr.headRefOid}`;
  if (woken.has(tag)) return;
  woken.add(tag);
  const reachable = owners.filter((id) => !isUnreachable(id));
  const fix = `merge ${pr.repository.defaultBranchRef.name} into ${pr.headRefName}, resolve, and push; auto-merge takes it from there`;
  for (const id of reachable) await tellSession(id, `${label(key)} is approved but ${problem}: ${fix}. ${pr.url}`);
  if (reachable.length > 0) {
    logAction(key, `asked ${reachable.join(", ")} to fix: ${problem}`);
    return;
  }
  await notify(`${label(key)} is approved but ${problem}, and no reachable session owns it: revive its chat or start a resolver to ${fix}. ${pr.url}`);
  logAction(key, `no reachable owner; asked the review agent for a resolver (${problem})`);
}

const needsRetarget = (pr: Pr, main: string) => pr.baseRefName !== main && (pr.baseRef === null || pr.baseRef.associatedPullRequests.totalCount > 0);

function retarget(pr: Pr, main: string) {
  const r = gh(["pr", "edit", String(pr.number), "-R", pr.repository.nameWithOwner, "--base", main]);
  logAction(keyOf(pr), r.ok ? `retargeted onto ${main}: its base ${pr.baseRefName} was merged` : `retarget onto ${main} failed: ${r.err}`);
}

async function updateBranch(pr: Pr, owners: string[], main: string) {
  const args = ["pr", "update-branch", String(pr.number), "-R", pr.repository.nameWithOwner];
  const first = gh(args);
  // constraint: GitHub refuses update-branch when the head moved since it was read; gh reads it afresh on a retry
  const r = !first.ok && /sha|head/i.test(first.err) ? gh(args) : first;
  logAction(keyOf(pr), r.ok ? `updated the branch from ${main}` : `update-branch failed: ${r.err}`);
  if (!r.ok) await wake(pr, owners, `behind ${main} and GitHub can't update the branch`);
}

function merge(pr: Pr) {
  // constraint: GitHub won't arm auto-merge on a PR that can merge right now, so that one merges directly
  const isClean = pr.mergeStateStatus === "CLEAN";
  const r = gh(["pr", "merge", String(pr.number), "-R", pr.repository.nameWithOwner, ...(isClean ? [] : ["--auto"]), "--squash"]);
  const done = isClean ? "merged" : "armed auto-merge";
  logAction(keyOf(pr), r.ok ? done : `merge failed: ${r.err}`);
}

async function land(pr: Pr, owners: string[]) {
  const main = pr.repository.defaultBranchRef.name;
  if (needsRetarget(pr, main)) {
    retarget(pr, main);
    return;
  }
  if (pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING") {
    await wake(pr, owners, `conflicts with ${main}`);
    return;
  }
  if (pr.mergeStateStatus === "BEHIND") await updateBranch(pr, owners, main);
  if (isCiFailing(ciOf(pr)) || pr.autoMergeRequest) return;
  merge(pr);
}

function trackReachability(sessions: Session[]) {
  blocked.clear();
  for (const s of sessions) {
    if (s.blocked) blocked.add(s.id);
    const isHoldingIdle = s.pending > 0 && s.status === "idle";
    if (!isHoldingIdle) {
      idleHoldingSince.delete(s.id);
      continue;
    }
    if (!idleHoldingSince.has(s.id)) idleHoldingSince.set(s.id, Date.now());
  }
}

const isTiedTo = (l: Link, pr: Pr) => l.repo === pr.repository.nameWithOwner.toLowerCase() && (l.pr === keyOf(pr) || l.branch === pr.headRefName);
const approvedAtOf = (pr: Pr) => Math.max(...pr.latestReviews.nodes.filter((r) => r.state === "APPROVED").map((r) => Date.parse(r.submittedAt)), 0);

function whyEscalated(pr: Pr, own: string[]) {
  const approvedAt = approvedAtOf(pr);
  const armed = pr.autoMergeRequest ? ", auto-merge armed" : "";
  const minutes = Math.round((Date.now() - approvedAt) / 60_000);
  return [
    approvedAt > 0 && Date.now() - approvedAt > ESCALATE_MS ? `approved ${minutes} min ago and still open (GitHub: ${pr.mergeStateStatus.toLowerCase()}${armed})` : "",
    own.length > 0 && own.every((id) => isUnreachable(id)) ? `owner ${own.join(", ")} isn't taking messages` : "",
  ].filter((reason) => reason !== "").join("; ");
}

async function escalateOnce(pr: Pr, key: string, why: string) {
  if (why === "") {
    escalated.delete(key);
    return;
  }
  if (escalated.has(key)) return;
  escalated.add(key);
  await notify(`Escalated ${label(key)}: ${why}. Last actions: ${(landingLog.get(key) ?? ["none"]).join("; ")}. ${pr.url}`);
}

async function landOne(pr: Pr, ties: Link[], live: Set<string>): Promise<LandingItem> {
  const key = keyOf(pr);
  const own = [...new Set(ties.filter((l) => l.session !== "" && live.has(l.session) && isTiedTo(l, pr)).map((l) => l.session))];
  try {
    await land(pr, own);
  } catch (error) {
    logAction(key, `landing failed: ${String(error)}`);
  }
  const why = whyEscalated(pr, own);
  await escalateOnce(pr, key, why);
  const actions = landingLog.get(key) ?? [pr.autoMergeRequest ? "auto-merge armed" : "approved"];
  const note = [why === "" ? "" : `ESCALATED: ${why}`, ...actions].filter((part) => part !== "").join(" · ");
  return { pr: label(key), url: pr.url, note, why };
}

function writeLandingBoard(items: LandingItem[]) {
  const sorted = items.toSorted((a, b) => Number(b.why !== "") - Number(a.why !== ""));
  const landing = sorted.length === 0 ? [] : [{ title: LANDING, items: sorted.map(({ why, ...item }) => item) }];
  const parsed = readStateJson(BOARD_FILE);
  const board = isRecord(parsed) ? parsed : {};
  const sections: unknown = board["sections"];
  const list: unknown[] = Array.isArray(sections) ? sections : [];
  const rest = list.filter((section) => !(isRecord(section) && section["title"] === LANDING));
  writeStateJson(BOARD_FILE, { ...board, sections: [...landing, ...rest] });
}

async function landAll(prs: Pr[], ties: Link[], sessions: Session[]) {
  trackReachability(sessions);
  const live = new Set(sessions.map((s) => s.id));
  const items: LandingItem[] = [];
  for (const pr of approvedPrs(prs)) items.push(await landOne(pr, ties, live));
  writeLandingBoard(items);
}

function sessionsOnPrs(prs: Pr[], ties: Link[], sessions: Session[]) {
  const names = new Map(sessions.map((s) => [s.id, s.name]));
  const on = new Map<string, string[]>();
  const owners = new Map<string, string[]>();
  for (const pr of prs) {
    const key = keyOf(pr);
    const owning = ties.filter((l) => l.session !== "" && isTiedTo(l, pr)).map((l) => l.session);
    const mentioning = sessions.filter((s) => s.links.some((u) => u.toLowerCase() === pr.url.toLowerCase())).map((s) => s.id);
    owners.set(key, [...new Set(owning)].filter((id) => names.has(id)));
    on.set(key, [...new Set([...owning, ...mentioning])].filter((id) => names.has(id)));
  }
  return { names, on, owners };
}

function queueEntry(pr: Pr, on: Map<string, string[]>, names: Map<string, string>): QueueEntry {
  const key = keyOf(pr);
  const kept = pr.mergeable === "UNKNOWN" ? stages.get(key) : undefined;
  return {
    pr: key, url: pr.url, title: pr.title, stage: kept ?? stage(pr), visual: /<img|!\[|user-attachments/.test(pr.body),
    ui: uiOf.get(pr.id) ?? false, created: pr.createdAt, updated: pr.updatedAt,
    sessions: (on.get(key) ?? []).map((id) => ({ id, name: names.get(id) })),
  };
}

function stageMoves(queue: QueueEntry[]) {
  const next = new Set(queue.map((q) => q.pr));
  const was = (key: string) => (stages.has(key) ? `${stages.get(key) ?? ""} -> ` : "new, ");
  return [
    ...queue.filter((q) => stages.get(q.pr) !== q.stage).map((q) => `${label(q.pr)} ${was(q.pr)}${q.stage}`),
    ...stages.keys().filter((k) => !next.has(k)).map((k) => `${label(k)} gone (merged or closed): ${titles.get(k) ?? ""}`),
  ];
}

async function tick() {
  const prs = openPrs();
  lookUpUi(prs);
  const sessions = (await fetchSessions()).filter((s) => s.running && !s.sentry);
  const ties = await links();
  const { names, on, owners } = sessionsOnPrs(prs, ties, sessions);
  const queue = prs.map((pr) => queueEntry(pr, on, names));
  writeStateJson(QUEUE_FILE, queue);
  writeWatches(queue.map((q): Watch => ({ pr: q.pr, sessions: owners.get(q.pr) ?? [] })), REVIEW_WATCH);
  writeStateJson("review-edges.json", queue.flatMap((q) => q.sessions.map((s) => ({ session: s.id, label: label(q.pr) }))));
  await landAll(prs, ties, sessions);

  const isFirst = stages.size === 0;
  const moved = stageMoves(queue);
  refill(stages, queue.map((q): [string, string] => [q.pr, q.stage]));
  refill(titles, queue.map((q): [string, string] => [q.pr, q.title]));
  if (isFirst) await notify(`Feed up: ${queue.length} open PRs staged in $MAXFLOW_STATE/${QUEUE_FILE}. Build the queue.`);
  else if (moved.length > 0) await notify(`Stage changes: ${moved.join("; ")}.`);
  process.title = `review feed (${queue.length} PRs)`;
}

const isPersonPost = (kind: string, d: EventData) => ["comment", "review", "thread"].includes(kind) && (d.who ?? "") !== "" && !isOwnComment(d.who);
const isUnheard = (kind: string, d: EventData) => isPersonPost(kind, d) && d.told.length === 0 && d.author?.endsWith("[bot]") !== true && stages.has(d.pr);

function describePost(kind: string, d: EventData) {
  if (kind === "review") return `review (${String(d.state?.toLowerCase().replace("_", " "))})`;
  return kind === "thread" ? `comment on ${String(d.path)}` : "comment";
}

function unheard(e: Event) {
  const d = e.data;
  const kind = e.topic.split("/").at(-1) ?? "";
  const body = (d.body ?? "").replaceAll(/\s+/g, " ").slice(0, 500);
  return isUnheard(kind, d) ? `${label(d.pr)}: ${describePost(kind, d)} from ${String(d.who)}, heard by no session: "${body}" ${d.url ?? ""}` : null;
}

async function latestSeq() {
  try {
    const res = await fetch(`${base}/api/events?topic=gh/**&after=now`, { signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
    return res.headers.get("x-maxflow-seq") ?? "0";
  } catch {
    return "0";
  }
}

async function eventsAfter(after: string, wait: number): Promise<Event[] | null> {
  try {
    const res = await fetch(`${base}/api/events?topic=gh/**&after=${after}&wait=${wait}`, { signal: AbortSignal.timeout(wait + EVENTS_GRACE_MS) });
    const events: unknown = await res.json();
    return Array.isArray(events) ? events.filter(isEvent) : [];
  } catch {
    return null;
  }
}

async function listenUntil(after: string, until: number) {
  let seen = after;
  for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
    const events = await eventsAfter(seen, left);
    if (events === null) {
      await Bun.sleep(left);
      continue;
    }
    const last = events.at(-1);
    if (last === undefined) continue;
    seen = String(last.seq);
    const lines = events.flatMap((e) => unheard(e) ?? []);
    for (const line of lines) await notify(line);
  }
  return seen;
}

async function feed() {
  let after = await latestSeq();
  for (;;) {
    if (process.ppid === 1) process.exit(0);
    try {
      await tick();
    } catch (error) {
      console.error(`${new Date().toLocaleTimeString()}  tick failed:`, error);
    }
    after = await listenUntil(after, Date.now() + INTERVAL_MS);
  }
}

if (import.meta.main) await feed();
