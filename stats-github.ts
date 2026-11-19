import { homedir } from "node:os";
import { join } from "node:path";
import { DIR } from "./instance";
import { isRecord } from "./shared/guards";
import { readStateJson, writeStateJson } from "./state";
import { errorMessage, peek, pick, pickArray, pickNumber, pickString } from "./stats-github-reply";
import { DAY_MS, addDays, mondayToSundayWeek, type Week } from "./stats-week";

export const DEFAULT_REPO = "Dryft-AI/app";
const CLONES: Record<string, string> = { "Dryft-AI/app": join(homedir(), "app"), "isaacchacko/yarn": DIR };
const GH_CACHE = "stats-github.json";
const GH_FRESH_MS = 15 * 60_000;
const SEARCH_INDEX_SETTLED_MS = 60 * 60_000;
const REPO_LIST_TTL_MS = 6 * 3_600_000;
const CALENDAR_TTL_MS = 3_600_000;
const GH_TIMEOUT_MS = 30_000;
// constraint: GitHub answers a busy search with a 502 now and then; a couple more tries, 3s then 10s apart, are usually enough.
const RETRY_DELAYS_MS = [3000, 10_000];
const MAX_MERGED_PAGES = 5;
const TREND_WEEKS = 12;

type Counts = { commits: number; opened: number; merged: number; closed: number; reviews: number; requested: number; added: number; deleted: number };
export type GhWeek = { at: number; final: boolean; counts?: Counts; commitTimes?: number[]; error?: string };
export type Calendar = { at: number; total: number; days: { date: string; count: number }[]; error?: string };
type Viewer = { login: string; id: string };

const isGhWeek = (value: unknown) => isRecord(value) && typeof value["at"] === "number" && typeof value["final"] === "boolean";
const isGhCache = (value: unknown): value is Record<string, GhWeek> => isRecord(value) && Object.values(value).every(isGhWeek);

const ghCache: Record<string, GhWeek> = readStateJson(GH_CACHE, isGhCache) ?? {};
const inflight = new Map<string, Promise<GhWeek>>();
const memo: {
  viewer: Promise<Viewer> | undefined;
  repoList: { at: number; repos: Promise<string[]> } | undefined;
  calendar: Calendar | undefined;
  calendarLoad: Promise<Calendar> | undefined;
  trendQueue: Promise<void>;
} = { viewer: undefined, repoList: undefined, calendar: undefined, calendarLoad: undefined, trendQueue: Promise.resolve() };

const hasError = (cached: { error?: string }) => cached.error !== undefined && cached.error !== "";

function cloneCommitTimes(clone: string, w: Week) {
  const r = Bun.spawnSync(["git", "-C", clone, "log", "--all", "--no-merges", "--author=Isaac Chacko", `--since=${new Date(w.from).toISOString()}`, `--until=${new Date(w.to).toISOString()}`, "--format=%at %s"], { stderr: "pipe" });
  const rebasedOrPickedCountOnce = r.exitCode === 0 ? new Set(r.stdout.toString().split("\n").filter((line) => line !== "")) : new Set<string>();
  return Array.from(rebasedOrPickedCountOnce, (line) => Number(line.slice(0, line.indexOf(" "))) * 1000).toSorted((a, b) => a - b);
}

async function graphql(query: string): Promise<unknown> {
  const p = Bun.spawn(["gh", "api", "graphql", "-f", `query=${query}`], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(9), GH_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(err.trim().slice(0, 300) || `gh exited ${code}`);
  const reply: unknown = JSON.parse(out);
  return isRecord(reply) ? reply["data"] : undefined;
}

async function retried(query: string): Promise<unknown> {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await graphql(query);
    } catch {
      await Bun.sleep(delay);
    }
  }
  return graphql(query);
}

async function fetchViewer(): Promise<Viewer> {
  try {
    const d = await graphql("query { viewer { login id } }");
    return { login: pickString(d, "viewer.login"), id: pickString(d, "viewer.id") };
  } catch (error) {
    memo.viewer = undefined;
    throw error;
  }
}

async function viewer() {
  memo.viewer ??= fetchViewer();
  return memo.viewer;
}

function reposFromReply(d: unknown) {
  const prCounts = new Map<string, number>();
  for (const n of pickArray(d, "search.nodes")) {
    const repo = peek(n, "repository.nameWithOwner");
    if (typeof repo === "string") prCounts.set(repo, (prCounts.get(repo) ?? 0) + 1);
  }
  const busiest = prCounts
    .entries()
    .toArray()
    .toSorted((a, b) => b[1] - a[1])
    .map(([r]) => r);
  const contributed = pickArray(d, "viewer.repositoriesContributedTo.nodes").map((r) => pickString(r, "nameWithOwner"));
  return [...new Set([DEFAULT_REPO, ...busiest, ...Object.keys(CLONES), ...contributed])];
}

async function lookUpRepos() {
  const since = new Date(Date.now() - 90 * DAY_MS).toISOString().slice(0, 10);
  try {
    return reposFromReply(
      await retried(`query { search(type: ISSUE, first: 100, query: "is:pr involves:@me updated:>=${since}") { nodes { ... on PullRequest { repository { nameWithOwner } } } }
    viewer { repositoriesContributedTo(first: 50, includeUserRepositories: true, orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { nameWithOwner } } } }`),
    );
  } catch (error) {
    console.error(`stats: listing his repos failed: ${errorMessage(error)}`);
    memo.repoList = undefined;
    return [DEFAULT_REPO, ...Object.keys(CLONES).filter((r) => r !== DEFAULT_REPO)];
  }
}

export async function reposByRecentWork(): Promise<string[]> {
  if (memo.repoList && Date.now() - memo.repoList.at < REPO_LIST_TTL_MS) return memo.repoList.repos;
  const repos = lookUpRepos();
  memo.repoList = { at: Date.now(), repos };
  return repos;
}

type WeekQuery = { repo: string; w: Week; range: string; clone: string | undefined };

function weekQueryText(q: WeekQuery, { login, id }: Viewer) {
  const { repo, w, range, clone } = q;
  const [owner = "", name = ""] = repo.split("/", 2);
  return `query {
    o: search(type: ISSUE, query: "is:pr author:@me repo:${repo} created:${range}") { issueCount }
    m: search(type: ISSUE, first: 100, query: "is:pr author:@me repo:${repo} merged:${range}") { issueCount pageInfo { endCursor hasNextPage } nodes { ... on PullRequest { additions deletions } } }
    c: search(type: ISSUE, query: "is:pr author:@me repo:${repo} is:unmerged closed:${range}") { issueCount }
    p: search(type: ISSUE, query: "is:pr review-requested:@me repo:${repo} created:${range}") { issueCount }
    d: search(type: ISSUE, query: "is:pr reviewed-by:@me -author:@me repo:${repo} created:${range}") { issueCount }
    r: search(type: ISSUE, first: 100, query: "is:pr reviewed-by:@me -author:@me repo:${repo} updated:${range}") { nodes { ... on PullRequest { reviews(first: 100, author: "${login}") { nodes { submittedAt } } } } }
    ${clone === undefined ? `h: repository(owner: "${owner}", name: "${name}") { defaultBranchRef { target { ... on Commit { history(since: "${new Date(w.from).toISOString()}", until: "${new Date(w.to).toISOString()}", author: { id: "${id}" }) { totalCount } } } } }` : ""}
  }`;
}

function reviewsInWeekOfPrsHeReviewed(data: unknown, w: Week) {
  return pickArray(data, "r.nodes")
    .flatMap((pr): unknown[] => {
      const nodes = peek(pr, "reviews.nodes");
      return Array.isArray(nodes) ? nodes : [];
    })
    .filter((review) => {
      const at = peek(review, "submittedAt");
      return typeof at === "string" && at !== "" && Date.parse(at) >= w.from && Date.parse(at) < w.to;
    }).length;
}

async function mergedLineCounts(data: unknown, q: WeekQuery) {
  const merged = pickArray(data, "m.nodes");
  let page = pick(data, "m.pageInfo");
  for (let n = 0; peek(page, "hasNextPage") === true && n < MAX_MERGED_PAGES; n += 1) {
    const more = pick(
      await retried(`query { m: search(type: ISSUE, first: 100, after: ${JSON.stringify(peek(page, "endCursor"))}, query: "is:pr author:@me repo:${q.repo} merged:${q.range}") { pageInfo { endCursor hasNextPage } nodes { ... on PullRequest { additions deletions } } } }`),
      "m",
    );
    merged.push(...pickArray(more, "nodes"));
    page = pick(more, "pageInfo");
  }
  return {
    added: merged.reduce((n: number, pr) => n + Number(peek(pr, "additions")), 0),
    deleted: merged.reduce((n: number, pr) => n + Number(peek(pr, "deletions")), 0),
  };
}

function defaultBranchCommits(data: unknown) {
  const total = peek(data, "h.defaultBranchRef.target.history.totalCount");
  return typeof total === "number" ? total : 0;
}

async function fetchGh(repo: string, w: Week): Promise<GhWeek> {
  const me = await viewer();
  const range = `${new Date(w.from).toISOString().slice(0, 19)}Z..${new Date(w.to - 1000).toISOString().slice(0, 19)}Z`;
  const q: WeekQuery = { repo, w, range, clone: CLONES[repo] };
  const data = await retried(weekQueryText(q, me));
  const reviews = reviewsInWeekOfPrsHeReviewed(data, w);
  const lines = await mergedLineCounts(data, q);
  const commitTimes = q.clone === undefined ? undefined : cloneCommitTimes(q.clone, w);
  const counts: Counts = {
    commits: commitTimes ? commitTimes.length : defaultBranchCommits(data),
    opened: pickNumber(data, "o.issueCount"),
    merged: pickNumber(data, "m.issueCount"),
    closed: pickNumber(data, "c.issueCount"),
    reviews,
    requested: pickNumber(data, "p.issueCount") + pickNumber(data, "d.issueCount"),
    ...lines,
  };
  return { at: Date.now(), final: Date.now() > w.to + SEARCH_INDEX_SETTLED_MS, counts, ...(commitTimes && { commitTimes }) };
}

async function fetchAndCache(repo: string, w: Week, key: string, hit: GhWeek | undefined): Promise<GhWeek> {
  try {
    const r = await fetchGh(repo, w);
    ghCache[key] = r;
    writeStateJson(GH_CACHE, ghCache);
    return r;
  } catch (error) {
    const message = errorMessage(error);
    console.error(`stats: GitHub fetch for ${repo} week ${w.key} failed: ${message}`);
    return hit ? { ...hit, error: message } : { at: Date.now(), final: false, error: message };
  } finally {
    inflight.delete(key);
  }
}

export async function gh(repo: string, w: Week): Promise<GhWeek> {
  const key = `${repo} ${w.key}`;
  const hit = ghCache[key];
  if (hit && !hasError(hit) && (hit.final || Date.now() - hit.at < GH_FRESH_MS)) return hit;
  const hasNotStarted = w.from > Date.now();
  if (hasNotStarted) return { at: Date.now(), final: false };
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchAndCache(repo, w, key, hit);
  inflight.set(key, p);
  return p;
}

async function fetchAfter(previous: Promise<void>, repo: string, w: Week) {
  await previous;
  await gh(repo, w);
}

export function trend(repo: string, w: Week) {
  const weeks = Array.from({ length: TREND_WEEKS }, (_, i) => mondayToSundayWeek(addDays(w.key, -7 * (TREND_WEEKS - 1 - i))));
  const missing = weeks.filter((x) => ghCache[`${repo} ${x.key}`]?.counts === undefined && !inflight.has(`${repo} ${x.key}`));
  for (const x of missing) memo.trendQueue = fetchAfter(memo.trendQueue, repo, x);
  return {
    pending: missing.length > 0 || weeks.some((x) => inflight.has(`${repo} ${x.key}`)),
    weeks: weeks.map((x) => ({ key: x.key, counts: ghCache[`${repo} ${x.key}`]?.counts })),
  };
}

function calendarFromReply(d: unknown): Calendar {
  const cal = pick(d, "viewer.contributionsCollection.contributionCalendar");
  const days = pickArray(cal, "weeks").flatMap((w) => pickArray(w, "contributionDays").map((x) => ({ date: pickString(x, "date"), count: pickNumber(x, "contributionCount") })));
  return { at: Date.now(), total: pickNumber(cal, "totalContributions"), days };
}

async function loadCalendar(): Promise<Calendar> {
  try {
    memo.calendar = calendarFromReply(await retried(`query { viewer { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }`));
    return memo.calendar;
  } catch (error) {
    const message = errorMessage(error);
    console.error(`stats: contribution calendar failed: ${message}`);
    return memo.calendar ? { ...memo.calendar, error: message } : { at: Date.now(), total: 0, days: [], error: message };
  } finally {
    memo.calendarLoad = undefined;
  }
}

export async function calendar(): Promise<Calendar> {
  const cached = memo.calendar;
  if (cached && !hasError(cached) && Date.now() - cached.at < CALENDAR_TTL_MS) return cached;
  memo.calendarLoad ??= loadCalendar();
  return memo.calendarLoad;
}
