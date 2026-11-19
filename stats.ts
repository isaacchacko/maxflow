import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DIR, STATE_DIR } from "./instance";

// The Stats page's numbers, one week at a time (Monday to Sunday in his time zone).
// GitHub: one repo at a time (Dryft-AI/app unless he picks another), one GraphQL call per repo and week (a 502 is tried twice more), cached in
// stats-github.json; a finished week is never fetched again and the current one at most every 15 minutes, since the token is shared with
// the sentries. Commits in a repo cloned here are counted from the clone, which costs no API call and sees every branch (maxflow's work
// lives on feat/v2, which GitHub's own count leaves out); elsewhere from the default branch's history.
// yarn: read from events.jsonl and threads.json, which only go back to when v2 started.

const TZ = "America/Los_Angeles";
const DAY = 86_400_000;
export const DEFAULT_REPO = "Dryft-AI/app";
const CLONES: Record<string, string> = { "Dryft-AI/app": `${process.env.HOME}/app`, "isaacchacko/maxflow": DIR };
const GH_CACHE = `${STATE_DIR}/stats-github.json`;
const GH_FRESH_MS = 15 * 60_000;
// GitHub's search index trails by a few minutes, so a week counts as final only once this long past its end.
const SETTLED_MS = 60 * 60_000;

/** How far his time zone is from UTC at that moment, in ms (negative west of it). */
function offset(at: number) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(new Date(at)).find(p => p.type === "timeZoneName")!.value;
  const m = name.match(/GMT([+-])(\d\d):(\d\d)/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
}
/** Midnight of a YYYY-MM-DD day in his time zone. */
function midnight(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  return guess - offset(guess - offset(guess));
}
const dayKey = (at: number) => new Date(at + offset(at)).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export type Week = { key: string; from: number; to: number; days: string[] };
/** The week holding `key` (any day in it), or this week; days run Monday to Sunday. */
export function week(key?: string): Week {
  const day = key && /^\d{4}-\d\d-\d\d$/.test(key) ? key : dayKey(Date.now());
  const monday = addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return { key: monday, from: midnight(monday), to: midnight(addDays(monday, 7)), days };
}

// ---- GitHub

type Counts = { commits: number; opened: number; merged: number; closed: number; reviews: number; requested: number; added: number; deleted: number };
export type GhWeek = { at: number; final: boolean; counts?: Counts; commitTimes?: number[]; error?: string };

const loadCache = (): Record<string, GhWeek> => {
  try {
    return existsSync(GH_CACHE) ? JSON.parse(readFileSync(GH_CACHE, "utf8")) : {};
  } catch {
    return {};
  }
};
const ghCache = loadCache();
const inflight = new Map<string, Promise<GhWeek>>();

function cloneCommits(clone: string, w: Week) {
  const r = Bun.spawnSync(["git", "-C", clone, "log", "--all", "--no-merges", "--author=Isaac Chacko", `--since=${new Date(w.from).toISOString()}`, `--until=${new Date(w.to).toISOString()}`, "--format=%at %s"], { stderr: "pipe" });
  // A rebased or cherry-picked commit keeps its author time and subject under a new hash, so those count once.
  const unique = r.exitCode === 0 ? new Set(r.stdout.toString().split("\n").filter(Boolean)) : new Set<string>();
  return [...unique].map(line => Number(line.slice(0, line.indexOf(" "))) * 1000).sort((a, b) => a - b);
}

async function graphql(query: string) {
  const p = Bun.spawn(["gh", "api", "graphql", "-f", `query=${query}`], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(9), 30_000);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(err.trim().slice(0, 300) || `gh exited ${code}`);
  return JSON.parse(out).data;
}
// GitHub answers a busy search with a 502 now and then; a couple more tries are usually enough.
const retried = (q: string) =>
  graphql(q)
    .catch(() => Bun.sleep(3000).then(() => graphql(q)))
    .catch(() => Bun.sleep(10_000).then(() => graphql(q)));

let me: Promise<{ login: string; id: string }> | undefined;
const viewer = () => (me ??= graphql("query { viewer { login id } }").then(d => d.viewer).catch(e => ((me = undefined), Promise.reject(e))));

let repoList: { at: number; repos: Promise<string[]> } | undefined;
/** The repos he worked in lately, his default first: the ones of his last 100 PRs, reviews and review requests (busiest first), the ones cloned
 * here, then the rest GitHub says he contributed to. Looked up at most every 6 hours. */
export function repos(): Promise<string[]> {
  if (repoList && Date.now() - repoList.at < 6 * 3600_000) return repoList.repos;
  const since = new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10);
  const p = retried(`query { search(type: ISSUE, first: 100, query: "is:pr involves:@me updated:>=${since}") { nodes { ... on PullRequest { repository { nameWithOwner } } } }
    viewer { repositoriesContributedTo(first: 50, includeUserRepositories: true, orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { nameWithOwner } } } }`)
    .then(d => {
      const seen = new Map<string, number>();
      for (const n of d.search.nodes as { repository?: { nameWithOwner: string } }[]) if (n.repository) seen.set(n.repository.nameWithOwner, (seen.get(n.repository.nameWithOwner) ?? 0) + 1);
      const busiest = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
      const contributed = (d.viewer.repositoriesContributedTo.nodes as { nameWithOwner: string }[]).map(r => r.nameWithOwner);
      return [...new Set([DEFAULT_REPO, ...busiest, ...Object.keys(CLONES), ...contributed])];
    })
    .catch((e: Error) => {
      console.error(`stats: listing his repos failed: ${e.message}`);
      repoList = undefined;
      return [DEFAULT_REPO, ...Object.keys(CLONES).filter(r => r !== DEFAULT_REPO)];
    });
  repoList = { at: Date.now(), repos: p };
  return p;
}

async function fetchGh(repo: string, w: Week): Promise<GhWeek> {
  const { login, id } = await viewer();
  const [owner, name] = repo.split("/");
  const range = `${new Date(w.from).toISOString().slice(0, 19)}Z..${new Date(w.to - 1000).toISOString().slice(0, 19)}Z`;
  const clone = CLONES[repo];
  // Merged PRs bring their line counts along.
  const q = `query {
    o: search(type: ISSUE, query: "is:pr author:@me repo:${repo} created:${range}") { issueCount }
    m: search(type: ISSUE, first: 100, query: "is:pr author:@me repo:${repo} merged:${range}") { issueCount pageInfo { endCursor hasNextPage } nodes { ... on PullRequest { additions deletions } } }
    c: search(type: ISSUE, query: "is:pr author:@me repo:${repo} is:unmerged closed:${range}") { issueCount }
    p: search(type: ISSUE, query: "is:pr review-requested:@me repo:${repo} created:${range}") { issueCount }
    d: search(type: ISSUE, query: "is:pr reviewed-by:@me -author:@me repo:${repo} created:${range}") { issueCount }
    r: search(type: ISSUE, first: 100, query: "is:pr reviewed-by:@me -author:@me repo:${repo} updated:${range}") { nodes { ... on PullRequest { reviews(first: 100, author: "${login}") { nodes { submittedAt } } } } }
    ${clone ? "" : `h: repository(owner: "${owner}", name: "${name}") { defaultBranchRef { target { ... on Commit { history(since: "${new Date(w.from).toISOString()}", until: "${new Date(w.to).toISOString()}", author: { id: "${id}" }) { totalCount } } } } }`}
  }`;
  const data = await retried(q);
  // The contributions API hides the org's private repos from this token, so reviews are counted off the PRs he reviewed.
  const reviews = (data.r.nodes as { reviews?: { nodes: { submittedAt: string | null }[] } }[])
    .flatMap(p => p.reviews?.nodes ?? [])
    .filter(r => r.submittedAt && Date.parse(r.submittedAt) >= w.from && Date.parse(r.submittedAt) < w.to).length;
  const merged = data.m.nodes as { additions: number; deletions: number }[];
  // Over 100 merged PRs in a week, the line counts need the rest of the pages.
  for (let page = data.m.pageInfo, n = 0; page.hasNextPage && n < 5; n++) {
    const more = (await retried(`query { m: search(type: ISSUE, first: 100, after: ${JSON.stringify(page.endCursor)}, query: "is:pr author:@me repo:${repo} merged:${range}") { pageInfo { endCursor hasNextPage } nodes { ... on PullRequest { additions deletions } } } }`)).m;
    merged.push(...more.nodes);
    page = more.pageInfo;
  }
  const commitTimes = clone ? cloneCommits(clone, w) : undefined;
  const counts: Counts = {
    commits: commitTimes ? commitTimes.length : (data.h?.defaultBranchRef?.target?.history?.totalCount ?? 0),
    opened: data.o.issueCount,
    merged: data.m.issueCount,
    closed: data.c.issueCount,
    reviews,
    requested: data.p.issueCount + data.d.issueCount,
    added: merged.reduce((n, p) => n + p.additions, 0),
    deleted: merged.reduce((n, p) => n + p.deletions, 0),
  };
  return { at: Date.now(), final: Date.now() > w.to + SETTLED_MS, counts, commitTimes };
}

export function gh(repo: string, w: Week): Promise<GhWeek> {
  const key = `${repo} ${w.key}`;
  const hit = ghCache[key];
  if (hit && !hit.error && (hit.final || Date.now() - hit.at < GH_FRESH_MS)) return Promise.resolve(hit);
  // A week that hasn't started has nothing to count.
  if (w.from > Date.now()) return Promise.resolve({ at: Date.now(), final: false });
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchGh(repo, w)
    .then(r => {
      ghCache[key] = r;
      writeFileSync(GH_CACHE, JSON.stringify(ghCache));
      return r;
    })
    .catch((e: Error) => {
      console.error(`stats: GitHub fetch for ${repo} week ${w.key} failed: ${e.message}`);
      // Keep showing what was fetched before; an error is retried on the next look.
      return hit ? { ...hit, error: e.message } : { at: Date.now(), final: false, error: e.message };
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---- yarn

type Sample = { at: number; ms: number };
export type Latency = { id: string; samples: Sample[] };
export type Count = { id: string; days: number[]; at: number[] };
export type YarnWeek = { since: number; latencies: Latency[]; counts: Count[] };

type Ev = { seq: number; at: number; topic: string; data: Record<string, unknown> };
type Msg = { from: string; at: number };
type Thread = { id: string; messages: Msg[] };

// Most of the log is screen reads; only these topics are parsed.
const WANTED = /"topic":"(signal\/isaac|signal-route\/|slack\/|thread\/|ask\/|wait\/|gh\/[^"]*\/(merged|opened)")/;

let parsed: { size: number; events: Ev[]; since: number } | undefined;
function events() {
  const file = `${STATE_DIR}/events.jsonl`;
  if (!existsSync(file)) return { events: [] as Ev[], since: Date.now() };
  const text = readFileSync(file, "utf8");
  if (parsed?.size === text.length) return parsed;
  const out: Ev[] = [];
  let since = Infinity;
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (since === Infinity) since = Number(line.match(/"at":(\d+)/)?.[1] ?? Infinity);
    if (!WANTED.test(line)) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  parsed = { size: text.length, events: out, since };
  return parsed;
}

const yarnCache = new Map<string, { at: number; value: YarnWeek }>();

export function yarn(w: Week): YarnWeek {
  const hit = yarnCache.get(w.key);
  if (hit && (hit.at > w.to || Date.now() - hit.at < 60_000)) return hit.value;
  const { events: evs, since } = events();
  const threads: Thread[] = existsSync(`${STATE_DIR}/threads.json`) ? JSON.parse(readFileSync(`${STATE_DIR}/threads.json`, "utf8")) : [];
  const inWeek = (at: number) => at >= w.from && at < w.to;
  const lat = (id: string): Latency => ({ id, samples: [] });
  const route = lat("route"), reply = lat("reply"), slack = lat("slack"), ask = lat("ask");
  const dayOf = (at: number) => w.days.indexOf(dayKey(at));
  const count = (id: string): Count => ({ id, days: Array(7).fill(0), at: [] });
  const tally = (c: Count, at: number) => {
    c.days[dayOf(at)]!++;
    c.at.push(at);
  };
  const said = count("said"), started = count("started"), opened = count("opened"), resolved = count("resolved"), prsOpened = count("prsOpened"), prsMerged = count("prsMerged");

  // His message → the funnel routing it: the server notes the routing as signal-route/<seq of the signal>.
  const bySeq = new Map<number, Ev>();
  const slackSeen = new Map<string, number>();
  const firstWait = new Map<string, number>();
  const resolvedAt = new Map<string, number>();
  const prs = { opened: new Map<string, number>(), merged: new Map<string, number>() };
  for (const e of evs) {
    const t = e.topic;
    if (t === "signal/isaac") {
      bySeq.set(e.seq, e);
      if (inWeek(e.at)) tally(said, e.at);
    } else if (t.startsWith("signal-route/")) {
      const s = bySeq.get(e.data.seq as number);
      if (s && inWeek(s.at)) route.samples.push({ at: s.at, ms: e.at - s.at });
    } else if (t.startsWith("slack/") && typeof e.data.ts === "string" && t !== "slack/notify") {
      // A Slack message can reach several watchers; the first one to report it is when yarn knew.
      const prev = slackSeen.get(e.data.ts);
      if (prev === undefined || e.at < prev) slackSeen.set(e.data.ts, e.at);
    } else if (t.startsWith("wait/")) {
      const id = t.slice(5);
      if (!firstWait.has(id)) firstWait.set(id, e.at);
    } else if (t.startsWith("thread/") && "resolved" in e.data) {
      if (e.data.resolved) resolvedAt.set(e.data.thread as string, e.at);
      else resolvedAt.delete(e.data.thread as string);
    } else if (t.startsWith("gh/") && (e.data.told as string[] | undefined)?.length) {
      const kind = t.endsWith("/merged") ? prs.merged : prs.opened;
      const pr = e.data.pr as string;
      if (!kind.has(pr)) kind.set(pr, e.at);
    }
  }
  for (const [ts, at] of slackSeen) {
    const sent = Number(ts) * 1000;
    if (inWeek(sent) && at >= sent) slack.samples.push({ at: sent, ms: at - sent });
  }
  // Sessions alive when the log began weren't started then.
  for (const at of firstWait.values()) if (inWeek(at) && at > since + 10 * 60_000) tally(started, at);
  for (const at of resolvedAt.values()) if (inWeek(at)) tally(resolved, at);
  for (const at of prs.opened.values()) if (inWeek(at)) tally(prsOpened, at);
  for (const at of prs.merged.values()) if (inWeek(at)) tally(prsMerged, at);

  // His message → the first agent reply in its thread, timed from the first of his messages since the last reply.
  const byThread = new Map(threads.map(t => [t.id, t]));
  for (const t of threads) {
    const first = t.messages[0];
    if (first && inWeek(first.at)) tally(opened, first.at);
    let waiting: number | undefined;
    for (const m of t.messages) {
      if (m.from === "isaac") waiting ??= m.at;
      else if (m.from !== "feed" && waiting !== undefined) {
        if (inWeek(waiting)) reply.samples.push({ at: waiting, ms: m.at - waiting });
        waiting = undefined;
      }
    }
  }
  // An agent asks him in a thread → he answers → that agent's next message there.
  for (const e of evs) {
    if (!e.topic.startsWith("ask/")) continue;
    const t = byThread.get(e.data.thread as string);
    const answer = t?.messages.find(m => m.from === "isaac" && m.at > e.at);
    const acted = answer && t!.messages.find(m => m.from === e.data.session && m.at > answer.at);
    if (answer && acted && inWeek(answer.at)) ask.samples.push({ at: answer.at, ms: acted.at - answer.at });
  }

  const value = { since, latencies: [route, reply, slack, ask], counts: [said, started, opened, resolved, prsOpened, prsMerged] };
  yarnCache.set(w.key, { at: Date.now(), value });
  return value;
}

const TREND_WEEKS = 12;
let trendQueue = Promise.resolve();
/** The repo's counts for the weeks up to `w`, from the cache only. Weeks not cached yet are fetched one at a time in the background, so the
 * page doesn't wait on a dozen GitHub calls; `pending` tells it to look again shortly. */
function trend(repo: string, w: Week) {
  const weeks = Array.from({ length: TREND_WEEKS }, (_, i) => week(addDays(w.key, -7 * (TREND_WEEKS - 1 - i))));
  const missing = weeks.filter(x => !ghCache[`${repo} ${x.key}`]?.counts && !inflight.has(`${repo} ${x.key}`));
  for (const x of missing) trendQueue = trendQueue.then(() => gh(repo, x).then(() => {}));
  return { pending: missing.length > 0 || weeks.some(x => inflight.has(`${repo} ${x.key}`)), weeks: weeks.map(x => ({ key: x.key, counts: ghCache[`${repo} ${x.key}`]?.counts })) };
}

export async function stats(key?: string, repo?: string) {
  const w = week(key);
  const prev = week(addDays(w.key, -7));
  // Only an owner/name is put into a search query.
  const r = repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : DEFAULT_REPO;
  const [now, before, list] = await Promise.all([gh(r, w), gh(r, prev), repos()]);
  return { week: w, gh: { repo: r, repos: list.includes(r) ? list : [...list, r], now, before, trend: trend(r, w) }, yarn: yarn(w), yarnBefore: yarn(prev) };
}
