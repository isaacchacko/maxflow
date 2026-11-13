#!/usr/bin/env bun
// review sentry's feed: runs beside the review agent (sentries/review.md) in its pane. It stages every open PR of the user's into
// review-queue.json, has the gh sentry watch them all, and notifies the agent when a PR changes stage or a person's comment
// reaches no session. Exits with the agent.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Link, links, ownComment, REVIEW_WATCH_FILE, type Watch } from "./gh";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const EDGES_FILE = join(STATE_DIR, "review-edges.json");
const QUEUE_FILE = join(STATE_DIR, "review-queue.json");
const BOARD_FILE = join(STATE_DIR, "review-board.json");
const INTERVAL_MS = Number(process.env.REVIEW_SENTRY_INTERVAL ?? 120_000);
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;
// Sent with each call that touches a session, so the graph draws this sentry doing it.
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };
const agent = process.env.MAXFLOW_SESSION!;

type Pr = {
  number: number; url: string; title: string; body: string; isDraft: boolean; mergeable: string; reviewDecision: string | null; headRefName: string; headRefOid: string;
  createdAt: string; updatedAt: string; repository: { nameWithOwner: string; defaultBranchRef: { name: string } }; reviewRequests: { totalCount: number }; id: string;
  autoMergeRequest: object | null; mergeStateStatus: string; baseRefName: string; baseRef: { associatedPullRequests: { totalCount: number } } | null;
  latestReviews: { nodes: { state: string; submittedAt: string }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
type Event = { seq: number; topic: string; data: { pr: string; told: string[]; id?: string; who?: string | null; author?: string; state?: string; body?: string; url?: string; path?: string } };
type Session = { id: string; name: string; running: boolean; links: string[]; sentry: boolean; pending: number; status: string; blocked: object | null };

const QUERY = `query { search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) { nodes { ... on PullRequest {
 id number url title body isDraft mergeable reviewDecision headRefName createdAt updatedAt repository { nameWithOwner } reviewRequests(first: 1) { totalCount }
  autoMergeRequest { enabledAt } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;
// What landing needs, fetched only for approved PRs: in the search it pushes the query past GitHub's 10s limit.
const LANDING_FIELDS = `id number url title body isDraft mergeable reviewDecision headRefName headRefOid mergeStateStatus baseRefName
  repository { nameWithOwner defaultBranchRef { name } } autoMergeRequest { enabledAt } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  baseRef { associatedPullRequests(states: MERGED, first: 1) { totalCount } } latestReviews(first: 20) { nodes { state submittedAt } }`;

// Approved PRs to land: the user's own, plus every PR the gh sentry polls for a live session (a QA bot's PR an agent drives, say).
function approvedPrs(mine: Pr[]): Pr[] {
  const ghState = join(STATE_DIR, "gh-state.json");
  const polled = existsSync(ghState) ? Object.entries(JSON.parse(readFileSync(ghState, "utf8")) as Record<string, { state: string; decision: string }>) : [];
  const keys = new Set([
    ...mine.filter((pr) => pr.reviewDecision === "APPROVED").map(keyOf),
    ...polled.filter(([, p]) => p.state === "OPEN" && p.decision === "APPROVED").map(([key]) => key),
  ]);
  const byRepo = Map.groupBy([...keys], (key) => key.split("#")[0]);
  const prs: Pr[] = [];
  for (const [repo, ks] of byRepo) {
    const [owner, name] = repo.split("/");
    const parts = ks.map((k) => `n${k.split("#")[1]}: pullRequest(number: ${k.split("#")[1]}) { ${LANDING_FIELDS} }`).join("\n");
    const r = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=query { r: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${parts} } }`], { stderr: "pipe" });
    if (r.exitCode !== 0) {
      console.error(`${new Date().toLocaleTimeString()}  landing lookup failed for ${repo}: ${r.stderr.toString().trim().split("\n")[0]}`);
      continue;
    }
    prs.push(...(Object.values(JSON.parse(r.stdout.toString()).data.r ?? {}) as (Pr | null)[]).filter((pr): pr is Pr => !!pr));
  }
  return prs.filter((pr) => pr.reviewDecision === "APPROVED" && !pr.isDraft && !NEVER_MERGE.test(pr.title) && !NEVER_MERGE.test(pr.body));
}

// Whether a PR changes frontend UI, by node id. Looked up once per PR in its own query: files in the search pushes it past GitHub's 10s limit.
const uiOf = new Map<string, boolean>();
function lookUpUi(prs: Pr[]) {
  const ids = prs.map((pr) => pr.id).filter((id) => !uiOf.has(id));
  for (let i = 0; i < ids.length; i += 25) {
    const q = `query { nodes(ids: ${JSON.stringify(ids.slice(i, i + 25))}) { ... on PullRequest { id files(first: 100) { nodes { path } } } } }`;
    const r = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${q}`], { stderr: "pipe" });
    if (r.exitCode !== 0) continue;
    for (const n of JSON.parse(r.stdout.toString()).data.nodes as { id: string; files: { nodes: { path: string }[] } | null }[])
      uiOf.set(n.id, !!n.files?.nodes.some((f) => /frontend\/.*\.(tsx|css)$/.test(f.path) && !/\.(test|stories)\.tsx$/.test(f.path)));
  }
}

function openPrs(): Pr[] {
  const r = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${QUERY}`], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim());
  return JSON.parse(r.stdout.toString()).data.search.nodes;
}

// How far a PR is from prod, as the one thing blocking it next.
// GitHub computes mergeable lazily and answers UNKNOWN meanwhile, so tick() keeps the last stage until it knows.
function stage(pr: Pr) {
  const ci = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflict";
  if (ci === "FAILURE" || ci === "ERROR") return "ci failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (ci && ci !== "SUCCESS") return "ci running";
  if (pr.reviewDecision === "APPROVED") return pr.autoMergeRequest ? "merging" : "approved";
  return pr.reviewRequests.totalCount ? "in review" : "needs reviewer";
}

const keyOf = (pr: Pr) => `${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase();
const label = (key: string) => key.split("/")[1];
const notify = (text: string) => fetch(`${base}/api/sessions/${agent}/notify`, { method: "POST", headers: caller, body: JSON.stringify({ text: `[maxflow review] ${text}` }) });

let stages = new Map<string, string>();
let titles = new Map<string, string>();

// Landing: every poll, an approved PR is pushed toward merged without waiting for anyone to notice it.
const LANDING = "Approved, not merged (the feed is landing these)";
const ESCALATE_MS = 30 * 60_000, STUCK_IDLE_MS = 60_000;
const NEVER_MERGE = /never[- ]merge|do not merge|don'?t merge|not for merge|^one-off/i;
const landingLog = new Map<string, string[]>();
const blocked = new Set<string>();
const idleHoldingSince = new Map<string, number>();
const woken = new Set<string>();
const escalated = new Set<string>();

function gh(args: string[]) {
  const r = Bun.spawnSync(["gh", ...args], { stderr: "pipe", stdout: "pipe" });
  return { ok: r.exitCode === 0, err: r.stderr.toString().trim().split("\n")[0] };
}

function logAction(key: string, what: string) {
  const log = landingLog.get(key) ?? landingLog.set(key, []).get(key)!;
  if (log[0]?.endsWith(` ${what}`)) return;
  log.unshift(`${new Date().toTimeString().slice(0, 5)} ${what}`);
  log.splice(4);
  console.log(`${new Date().toLocaleTimeString()}  ${key}  ${what}`);
}

// An idle agent at an empty prompt gets its messages within seconds, so one still holding them a minute later is stuck; a working one gets them when its turn ends.
const unreachable = (id: string) => blocked.has(id) || Date.now() - (idleHoldingSince.get(id) ?? Date.now()) > STUCK_IDLE_MS;

// Hands a fix only a person or agent can make (a conflict, a branch GitHub won't update) to the PR's owner, or to the review agent when nobody reachable owns it.
async function wake(pr: Pr, owners: string[], problem: string) {
  const key = keyOf(pr), tag = `${key} ${problem} ${pr.headRefOid}`;
  if (woken.has(tag)) return;
  woken.add(tag);
  const reachable = owners.filter((id) => !unreachable(id));
  const fix = `merge ${pr.repository.defaultBranchRef.name} into ${pr.headRefName}, resolve, and push; auto-merge takes it from there`;
  for (const id of reachable)
    await fetch(`${base}/api/sessions/${id}/notify`, { method: "POST", headers: caller, body: JSON.stringify({ text: `[maxflow review] ${label(key)} is approved but ${problem}: ${fix}. ${pr.url}` }) });
  if (reachable.length) return logAction(key, `asked ${reachable.join(", ")} to fix: ${problem}`);
  await notify(`${label(key)} is approved but ${problem}, and no reachable session owns it: revive its chat or start a resolver to ${fix}. ${pr.url}`);
  logAction(key, `no reachable owner; asked the review agent for a resolver (${problem})`);
}

async function land(pr: Pr, owners: string[]) {
  const key = keyOf(pr), repo = pr.repository.nameWithOwner, n = String(pr.number), main = pr.repository.defaultBranchRef.name;
  const ci = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  if (pr.baseRefName !== main && (!pr.baseRef || pr.baseRef.associatedPullRequests.totalCount)) {
    const r = gh(["pr", "edit", n, "-R", repo, "--base", main]);
    return logAction(key, r.ok ? `retargeted onto ${main}: its base ${pr.baseRefName} was merged` : `retarget onto ${main} failed: ${r.err}`);
  }
  if (pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING") return wake(pr, owners, `conflicts with ${main}`);
  if (pr.mergeStateStatus === "BEHIND") {
    let r = gh(["pr", "update-branch", n, "-R", repo]);
    // GitHub refuses when the head moved since it was read; gh reads it afresh on the retry.
    if (!r.ok && /sha|head/i.test(r.err)) r = gh(["pr", "update-branch", n, "-R", repo]);
    logAction(key, r.ok ? `updated the branch from ${main}` : `update-branch failed: ${r.err}`);
    if (!r.ok) await wake(pr, owners, `behind ${main} and GitHub can't update the branch`);
  }
  if (ci === "FAILURE" || ci === "ERROR" || pr.autoMergeRequest) return;
  // GitHub won't arm auto-merge on a PR that can merge right now, so that one merges directly.
  const r = pr.mergeStateStatus === "CLEAN" ? gh(["pr", "merge", n, "-R", repo, "--squash"]) : gh(["pr", "merge", n, "-R", repo, "--auto", "--squash"]);
  logAction(key, r.ok ? (pr.mergeStateStatus === "CLEAN" ? "merged" : "armed auto-merge") : `merge failed: ${r.err}`);
}

// The landing section sits first on the board, rewritten every poll, with each PR's recent actions and why it's escalated.
async function landAll(prs: Pr[], ties: Link[], sessions: Session[]) {
  blocked.clear();
  for (const s of sessions) {
    if (s.blocked) blocked.add(s.id);
    if (!(s.pending && s.status === "idle")) idleHoldingSince.delete(s.id);
    else if (!idleHoldingSince.has(s.id)) idleHoldingSince.set(s.id, Date.now());
  }
  const live = new Set(sessions.map((s) => s.id));
  const items = [];
  for (const pr of approvedPrs(prs)) {
    const key = keyOf(pr), repo = pr.repository.nameWithOwner.toLowerCase();
    const own = [...new Set(ties.filter((l) => l.session && live.has(l.session) && l.repo === repo && (l.pr === key || l.branch === pr.headRefName)).map((l) => l.session))];
    try {
      await land(pr, own);
    } catch (e) {
      logAction(key, `landing failed: ${e}`);
    }
    const approvedAt = Math.max(...pr.latestReviews.nodes.filter((r) => r.state === "APPROVED").map((r) => Date.parse(r.submittedAt)), 0);
    const why = [
      approvedAt && Date.now() - approvedAt > ESCALATE_MS ? `approved ${Math.round((Date.now() - approvedAt) / 60_000)} min ago and still open (GitHub: ${pr.mergeStateStatus.toLowerCase()}${pr.autoMergeRequest ? ", auto-merge armed" : ""})` : "",
      own.length && own.every(unreachable) ? `owner ${own.join(", ")} isn't taking messages` : "",
    ].filter(Boolean).join("; ");
    if (why && !escalated.has(key)) {
      escalated.add(key);
      await notify(`Escalated ${label(key)}: ${why}. Last actions: ${(landingLog.get(key) ?? ["none"]).join("; ")}. ${pr.url}`);
    }
    if (!why) escalated.delete(key);
    items.push({ pr: label(key), url: pr.url, note: [why && `ESCALATED: ${why}`, ...(landingLog.get(key) ?? [pr.autoMergeRequest ? "auto-merge armed" : "approved"])].filter(Boolean).join(" · "), why });
  }
  items.sort((a, b) => Number(!!b.why) - Number(!!a.why));
  const board = existsSync(BOARD_FILE) ? JSON.parse(readFileSync(BOARD_FILE, "utf8")) : { sections: [] };
  board.sections = [...(items.length ? [{ title: LANDING, items: items.map(({ why, ...item }) => item) }] : []), ...(board.sections ?? []).filter((s: { title: string }) => s.title !== LANDING)];
  writeFileSync(`${BOARD_FILE}.tmp`, JSON.stringify(board, null, 2));
  renameSync(`${BOARD_FILE}.tmp`, BOARD_FILE);
}

async function tick() {
  const prs = openPrs();
  lookUpUi(prs);
  const sessions = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running && !s.sentry);
  const names = new Map(sessions.map((s) => [s.id, s.name]));
  const ties = await links();
  const on = new Map<string, string[]>();
  const owners = new Map<string, string[]>();
  for (const pr of prs) {
    const repo = pr.repository.nameWithOwner.toLowerCase(), key = keyOf(pr);
    const owning = ties.filter((l) => l.session && l.repo === repo && (l.pr === key || l.branch === pr.headRefName)).map((l) => l.session);
    const mentioning = sessions.filter((s) => s.links.some((u) => u.toLowerCase() === pr.url.toLowerCase())).map((s) => s.id);
    owners.set(key, [...new Set(owning)].filter((id) => names.has(id)));
    on.set(key, [...new Set([...owning, ...mentioning])].filter((id) => names.has(id)));
  }
  const queue = prs.map((pr) => ({
    pr: keyOf(pr), url: pr.url, title: pr.title, stage: (pr.mergeable === "UNKNOWN" && stages.get(keyOf(pr))) || stage(pr), visual: /<img|!\[|user-attachments/.test(pr.body),
    ui: uiOf.get(pr.id) ?? false, created: pr.createdAt, updated: pr.updatedAt,
    sessions: on.get(keyOf(pr))!.map((id) => ({ id, name: names.get(id) })),
  }));
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  writeFileSync(REVIEW_WATCH_FILE, JSON.stringify(queue.map((q): Watch => ({ pr: q.pr, sessions: owners.get(q.pr)! }))));
  writeFileSync(EDGES_FILE, JSON.stringify(queue.flatMap((q) => q.sessions.map((s) => ({ session: s.id, label: label(q.pr) })))));
  await landAll(prs, ties, sessions);

  const next = new Map(queue.map((q) => [q.pr, q.stage]));
  const first = !stages.size;
  const moved = [
    ...queue.filter((q) => stages.get(q.pr) !== q.stage).map((q) => `${label(q.pr)} ${stages.has(q.pr) ? `${stages.get(q.pr)} -> ` : "new, "}${q.stage}`),
    ...[...stages.keys()].filter((k) => !next.has(k)).map((k) => `${label(k)} gone (merged or closed): ${titles.get(k)}`),
  ];
  stages = next;
  titles = new Map(queue.map((q) => [q.pr, q.title]));
  if (first) await notify(`Feed up: ${queue.length} open PRs staged in ${QUEUE_FILE}. Build the queue.`);
  else if (moved.length) await notify(`Stage changes: ${moved.join("; ")}.`);
  process.title = `review feed (${queue.length} PRs)`;
}

// A person's comment or review that no session heard about falls to the agent to deliver; the user's own go to the funnel instead.
function unheard(e: Event) {
  const d = e.data, kind = e.topic.split("/").at(-1)!;
  if (!["comment", "review", "thread"].includes(kind) || !d.who || ownComment(d.who) || d.told.length || d.author?.endsWith("[bot]") || !stages.has(d.pr)) return null;
  const what = kind === "review" ? `review (${d.state?.toLowerCase().replace("_", " ")})` : kind === "thread" ? `comment on ${d.path}` : "comment";
  return `${label(d.pr)}: ${what} from ${d.who}, heard by no session: "${(d.body ?? "").replace(/\s+/g, " ").slice(0, 500)}" ${d.url ?? ""}`;
}

if (import.meta.main) {
  let after = (await fetch(`${base}/api/events?topic=gh/**&after=now`).catch(() => null))?.headers.get("x-maxflow-seq") ?? "0";
  for (;;) {
    if (process.ppid === 1) process.exit(0);
    try {
      await tick();
    } catch (e) {
      console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
    }
    const until = Date.now() + INTERVAL_MS;
    for (let left = INTERVAL_MS; left > 0; left = until - Date.now()) {
      const events = (await fetch(`${base}/api/events?topic=gh/**&after=${after}&wait=${left}`).then((r) => r.json()).catch(() => null)) as Event[] | null;
      if (!events) await Bun.sleep(left);
      if (!events?.length) continue;
      after = String(events.at(-1)!.seq);
      for (const line of events.map(unheard).filter(Boolean)) await notify(line!);
    }
  }
}
