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
const CALENDAR_CACHE = "stats-calendar.json";
const GH_FRESH_MS = 15 * 60_000;
const SEARCH_INDEX_SETTLED_MS = 60 * 60_000;
const REPO_LIST_TTL_MS = 6 * 3_600_000;
const CALENDAR_TTL_MS = 3_600_000;
const GH_TIMEOUT_MS = 30_000;
// constraint: GitHub answers a busy search with a 502 now and then; a couple more tries, 3s then 10s apart, are usually enough.
const RETRY_DELAYS_MS = [3000, 10_000];
const MAX_MERGED_PAGES = 5;
const TREND_WEEKS = 12;
const RETRY_AFTER_FAILURE_MS = 60_000;

type Counts = { commits: number; opened: number; merged: number; closed: number; reviews: number; requested: number; added: number; deleted: number };
export type GhWeek = { at: number; final: boolean; counts?: Counts; commitTimes?: number[]; error?: string; pending?: boolean; refreshing?: boolean };
export type Calendar = { at: number; total: number; days: { date: string; count: number }[]; error?: string; refreshing?: boolean };
type Viewer = { login: string; id: string };

const isGhWeek = (value: unknown) => isRecord(value) && typeof value["at"] === "number" && typeof value["final"] === "boolean";
const isGhCache = (value: unknown): value is Record<string, GhWeek> => isRecord(value) && Object.values(value).every(isGhWeek);
const isCalendar = (value: unknown): value is Calendar => isRecord(value) && typeof value["at"] === "number" && typeof value["total"] === "number" && Array.isArray(value["days"]);
const FALLBACK_REPOS = [DEFAULT_REPO, ...Object.keys(CLONES).filter((r) => r !== DEFAULT_REPO)];

const ghCache: Record<string, GhWeek> = readStateJson(GH_CACHE, isGhCache) ?? {};
const inflight = new Map<string, Promise<GhWeek>>();
const failures = new Map<string, { at: number; error: string }>();
const memo: {
  viewer: Promise<Viewer> | undefined;
  repoList: { at: number; repos: string[] } | undefined;
  repoLoad: Promise<void> | undefined;
  calendar: Calendar | undefined;
  calendarLoad: Promise<Calendar> | undefined;
  calendarFailedAt: number;
  trendQueue: Promise<void>;
} = { viewer: undefined, repoList: undefined, repoLoad: undefined, calendar: readStateJson(CALENDAR_CACHE, isCalendar), calendarLoad: undefined, calendarFailedAt: 0, trendQueue: Promise.resolve() };

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
    const repos = reposFromReply(
      await retried(`query { search(type: ISSUE, first: 100, query: "is:pr involves:@me updated:>=${since}") { nodes { ... on PullRequest { repository { nameWithOwner } } } }
    viewer { repositoriesContributedTo(first: 50, includeUserRepositories: true, orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { nameWithOwner } } } }`),
    );
    memo.repoList = { at: Date.now(), repos };
  } catch (error) {
    console.error(`stats: listing his repos failed: ${errorMessage(error)}`);
  } finally {
    memo.repoLoad = undefined;
  }
}

export function reposByRecentWork(): string[] {
  const known = memo.repoList;
  if (known === undefined || Date.now() - known.at >= REPO_LIST_TTL_MS) memo.repoLoad ??= lookUpRepos();
  return known?.repos ?? FALLBACK_REPOS;
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
    const after = JSON.stringify(peek(page, "endCursor"));
    const reply = await retried(`query { m: search(type: ISSUE, first: 100, after: ${after}, query: "is:pr author:@me repo:${q.repo} merged:${q.range}") { pageInfo { endCursor hasNextPage } nodes { ... on PullRequest { additions deletions } } } }`);
    const more = pick(reply, "m");
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
    failures.delete(key);
    return r;
  } catch (error) {
    const message = errorMessage(error);
    failures.set(key, { at: Date.now(), error: message });
    console.error(`stats: GitHub fetch for ${repo} week ${w.key} failed: ${message}`);
    return hit ? { ...hit, error: message } : { at: Date.now(), final: false, error: message };
  } finally {
    inflight.delete(key);
  }
}

async function refresh(repo: string, w: Week, key: string) {
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchAndCache(repo, w, key, ghCache[key]);
  inflight.set(key, p);
  return p;
}

const isFresh = (hit: GhWeek) => !hasError(hit) && (hit.final || Date.now() - hit.at < GH_FRESH_MS);

export async function gh(repo: string, w: Week): Promise<GhWeek> {
  const key = `${repo} ${w.key}`;
  const hit = ghCache[key];
  if (hit && isFresh(hit)) return hit;
  if (w.from > Date.now()) return { at: Date.now(), final: false };
  return refresh(repo, w, key);
}

export function ghNow(repo: string, w: Week): GhWeek {
  const key = `${repo} ${w.key}`;
  const hit = ghCache[key];
  if (hit && isFresh(hit)) return hit;
  if (w.from > Date.now()) return { at: Date.now(), final: false };
  const failure = failures.get(key);
  if (failure && Date.now() - failure.at < RETRY_AFTER_FAILURE_MS) return { ...(hit ?? { at: failure.at, final: false }), error: failure.error };
  void refresh(repo, w, key);
  return hit ? { ...hit, refreshing: true } : { at: Date.now(), final: false, pending: true };
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
    writeStateJson(CALENDAR_CACHE, memo.calendar);
    return memo.calendar;
  } catch (error) {
    const message = errorMessage(error);
    memo.calendarFailedAt = Date.now();
    console.error(`stats: contribution calendar failed: ${message}`);
    return memo.calendar ? { ...memo.calendar, error: message } : { at: Date.now(), total: 0, days: [], error: message };
  } finally {
    memo.calendarLoad = undefined;
  }
}

export async function calendar(): Promise<Calendar> {
  const cached = memo.calendar;
  if (cached && !hasError(cached) && Date.now() - cached.at < CALENDAR_TTL_MS) return cached;
  if (cached && memo.calendarLoad === undefined && Date.now() - memo.calendarFailedAt < RETRY_AFTER_FAILURE_MS) return cached;
  memo.calendarLoad ??= loadCalendar();
  return cached ? { ...cached, refreshing: true } : memo.calendarLoad;
}
