import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE as base } from "../instance";
import { isRecord } from "../shared/guards";
import { INBOX_WATCH, repoOf, type Watch } from "../gh";
import { writeStateJson } from "../state";
import { closeTask, dig, log, onBoard, post, repoAndNumber, run, shortened } from "./inbox-board";
import { feed } from "./inbox-feed";
import { type ReviewPr, state } from "./inbox-state";
import { fetchSessions } from "./slack-sessions";

const CLI = new URL("../cli.ts", import.meta.url).pathname;
const DAY_MS = 86_400_000;
const GONE_PR_WATCHED_MS = 7 * DAY_MS;
const REVIEW_AGENT_MIN_LINES = 800;
const REVIEW_AGENT_RISKY_PATHS = /migrat|alembic|\.sql$|erp|sap|terraform|infra|helm|k8s|kubernetes|\.github\/workflows|dockerfile|auth|permission|secret/i;
const MAX_REVIEW_AGENTS = 2;
const START_SESSION_MS = 60_000;
export const GITHUB_BOT_LOGIN = /\[bot\]$|^(github-actions|dependabot|renovate)$/i;

const PR_QUERY = (q: string) => `query { search(query: ${JSON.stringify(q)}, type: ISSUE, first: 50) { nodes { ... on PullRequest {
  number url title updatedAt additions deletions author { login } repository { nameWithOwner }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, ASSIGNED_EVENT], last: 1) { nodes { ... on ReviewRequestedEvent { createdAt } ... on AssignedEvent { createdAt } } } } } } }`;
type SearchPr = {
  number: number;
  url: string;
  title: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  timelineItems: { nodes: { createdAt: string }[] };
};
type Look = { ghMe: string; isFirstLook: boolean };

const isSearchPr = (value: unknown): value is SearchPr =>
  isRecord(value) &&
  typeof value["number"] === "number" &&
  typeof value["url"] === "string" &&
  typeof value["title"] === "string" &&
  typeof value["updatedAt"] === "string" &&
  typeof value["additions"] === "number" &&
  typeof value["deletions"] === "number" &&
  typeof dig(value, ["repository", "nameWithOwner"]) === "string" &&
  Array.isArray(dig(value, ["timelineItems", "nodes"]));

function searchPrs(q: string): SearchPr[] | null {
  const out = run(["gh", "api", "graphql", "-f", `query=${PR_QUERY(q)}`]);
  try {
    const nodes = dig(JSON.parse(out), ["data", "search", "nodes"]);
    return Array.isArray(nodes) ? nodes.filter(isSearchPr) : null;
  } catch {
    return null;
  }
}

function changedFiles(pr: SearchPr) {
  const [owner = "", name = ""] = pr.repository.nameWithOwner.split("/", 2);
  const query = `query=query { repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { files(first: 100) { nodes { path } } } } }`;
  const out = run(["gh", "api", "graphql", "-f", query]);
  try {
    const nodes = dig(JSON.parse(out), ["data", "repository", "pullRequest", "files", "nodes"]);
    return Array.isArray(nodes) ? nodes.map((node: unknown) => dig(node, ["path"])).filter((path) => typeof path === "string") : null;
  } catch {
    return null;
  }
}

function reviewAgentReason(key: string, pr: SearchPr) {
  const lines = pr.additions + pr.deletions;
  if (lines > REVIEW_AGENT_MIN_LINES) return `${lines} lines changed`;
  const paths = changedFiles(pr);
  if (paths === null) {
    log(`files of ${key} unreadable`);
    return null;
  }
  const hits = paths.filter((p) => REVIEW_AGENT_RISKY_PATHS.test(p));
  if (hits.length === 0) return null;
  return `touches ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ` +${hits.length - 3}` : ""}`;
}

function cloneOf(repo: string) {
  const name = repo.split("/", 2)[1] ?? "";
  return [join(homedir(), name), join(homedir(), "Programs", name), join(homedir(), "app")].find((d) => existsSync(join(d, ".git")) && repoOf(d) === repo);
}

function didMakeReviewWorktree(clone: string, dir: string, n: string) {
  run(["git", "-C", clone, "fetch", "-q", "origin", `pull/${n}/head`]);
  return run(["git", "-C", clone, "worktree", "add", "--detach", dir, "FETCH_HEAD"]) !== "" || existsSync(dir);
}

async function startReviewSession(name: string, dir: string) {
  const res = await fetch(`${base}/api/sessions`, {
    method: "POST",
    body: JSON.stringify({ name, cwd: dir, cmd: ["claude", "--permission-mode", "bypassPermissions"] }),
    signal: AbortSignal.timeout(START_SESSION_MS),
  });
  if (!res.ok) return null;
  const id = dig(await res.json(), ["id"]);
  return typeof id === "string" ? id : null;
}

const reviewerBrief = (pr: ReviewPr) =>
  `[maxflow inbox] You are a review agent for ${pr.url} ("${pr.title}" by ${pr.author}), which requests the user's review. It was picked for a careful read because it ${String(pr.risk)}. This folder is a detached worktree of its head. Read the diff (gh pr diff ${pr.url}) and the code around it, and look for correctness bugs and data-safety risks: migrations, ERP/SAP writes, infra, auth. Make no GitHub or Slack writes at all: no comments, reviews, approvals, reviewer requests or pushes. End your turn with your findings ranked by severity, each with file:line and a one-line fix, then a verdict (approve, approve with nits, or request changes) the user can act on, then run \`${CLI} wait done\`.`;

async function hasRoomForReviewer() {
  const live = new Set((await fetchSessions()).filter((s) => s.running).map((s) => s.id));
  return Object.values(state.prs).filter((p) => p.agent !== undefined && p.agent !== "" && live.has(p.agent)).length < MAX_REVIEW_AGENTS;
}

async function startReviewer(key: string, pr: ReviewPr) {
  if (!(await hasRoomForReviewer())) return null;
  const [repo = "", n = ""] = key.split("#", 2);
  const clone = cloneOf(repo);
  if (clone === undefined) {
    log(`no clone of ${repo} for a reviewer`);
    return null;
  }
  const repoName = repo.split("/", 2)[1] ?? "";
  const dir = join(homedir(), "Worktrees", `review-${repoName}-${n}`);
  if (!existsSync(dir) && !didMakeReviewWorktree(clone, dir, n)) {
    log(`worktree for ${key} failed`);
    return null;
  }
  const id = await startReviewSession(`review ${repoName}#${n}`, dir);
  if (id === null) return null;
  await post(`/api/sessions/${id}/notify`, { text: reviewerBrief(pr) });
  log(`reviewer ${id} on ${key}: ${String(pr.risk)}`);
  return id;
}

const timeOrNow = (text: string) => {
  const parsed = Date.parse(text);
  return parsed === 0 || Number.isNaN(parsed) ? Date.now() : parsed;
};
const prKey = (pr: SearchPr) => `${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase();
const reviewTaskTitle = (key: string, why: ReviewPr["why"], title: string) =>
  why === "review" ? `Review ${repoAndNumber(key)}: ${shortened(title, 60)}` : `${repoAndNumber(key)} assigned to you: ${shortened(title, 50)}`;

function rememberPr(key: string, pr: SearchPr, why: ReviewPr["why"]) {
  const previous = state.prs[key];
  const requested = timeOrNow(pr.timelineItems.nodes[0]?.createdAt ?? "");
  state.prs[key] = { ...previous, url: pr.url, title: pr.title, author: pr.author?.login ?? "?", why, requested, updated: Date.parse(pr.updatedAt), gone: undefined };
  return { previous, requested };
}

const isAskedAgain = ({ previous, requested }: { previous: ReviewPr | undefined; requested: number }) =>
  previous === undefined || (previous.gone ?? 0) !== 0 || previous.requested !== requested;


const askOf = (why: ReviewPr["why"], author: string | undefined) =>
  why === "review" ? `${String(author)} requested your review` : `assigned to you by ${String(author)}'s PR`;

async function startReviewerIfRisky(key: string, pr: SearchPr, isFirstLook: boolean) {
  const entry = state.prs[key];
  const risk = isFirstLook ? null : reviewAgentReason(key, pr);
  if (!entry || risk === null) return null;
  entry.risk = risk;
  const agent = await startReviewer(key, entry);
  if (agent !== null) entry.agent = agent;
  return agent;
}

function feedReviewRequest(task: number, key: string, pr: SearchPr, ask: string) {
  const author = pr.author?.login;
  if (GITHUB_BOT_LOGIN.test(author ?? "")) return;
  feed({ task, key, source: "review request", who: author ?? "?", where: key, text: `${ask}: "${pr.title}"`, link: pr.url, user: author });
}

async function notePr(key: string, found: { pr: SearchPr; why: ReviewPr["why"] }, look: Look) {
  const { pr, why } = found;
  const author = pr.author?.login;
  if (author === look.ghMe || !isAskedAgain(rememberPr(key, pr, why))) return;
  const agent = await startReviewerIfRisky(key, pr, look.isFirstLook);
  const reading = agent === null ? "" : `; review agent ${agent} reading it (${String(state.prs[key]?.risk)})`;
  const ask = askOf(why, author);
  const task = await onBoard(key, pr.url, `${ask}${reading}`, { title: reviewTaskTitle(key, why, pr.title), status: "you" });
  if (task !== null && agent === null && !look.isFirstLook) feedReviewRequest(task, key, pr, ask);
}

async function closeGonePrs(current: Map<string, unknown>) {
  for (const [key, pr] of Object.entries(state.prs)) {
    if (current.has(key) || (pr.gone ?? 0) !== 0) continue;
    pr.gone = Date.now();
    await closeTask(key, pr.why === "review" ? "it no longer requests your review (you reviewed, or the request was removed)" : "no longer assigned to you");
  }
}

const isLongGone = (pr: ReviewPr) => pr.gone !== undefined && pr.gone !== 0 && Date.now() - pr.gone > GONE_PR_WATCHED_MS;
function forgetLongGonePrs() {
  const gone = new Set(
    Object.entries(state.prs)
      .filter(([, pr]) => isLongGone(pr))
      .map(([key]) => key),
  );
  state.prs = Object.fromEntries(Object.entries(state.prs).filter(([key]) => !gone.has(key)));
  state.tasks = Object.fromEntries(Object.entries(state.tasks).filter(([key]) => !gone.has(key)));
}

export async function refreshPrs(ghMe: string) {
  const requested = searchPrs("is:pr is:open review-requested:@me archived:false");
  const assigned = searchPrs(`is:pr is:open assignee:@me -author:@me archived:false`);
  if (!requested || !assigned) {
    log("PR search failed");
    return;
  }
  const look: Look = { ghMe, isFirstLook: state.prsAt === 0 };
  const current = new Map<string, { pr: SearchPr; why: ReviewPr["why"] }>();
  for (const pr of assigned) current.set(prKey(pr), { pr, why: "assigned" });
  for (const pr of requested) current.set(prKey(pr), { pr, why: "review" });
  for (const [key, found] of current) await notePr(key, found, look);
  await closeGonePrs(current);
  forgetLongGonePrs();
  const watches = Object.entries(state.prs).map(([pr, p]): Watch => ({ pr, sessions: p.agent === undefined || p.agent === "" ? [] : [p.agent] }));
  writeStateJson(INBOX_WATCH, watches);
  state.prsAt = Date.now();
}
