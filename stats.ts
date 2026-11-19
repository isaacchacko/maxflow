import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DIR, STATE_DIR } from "./instance";
import { ACTIVE_GAP_MS, cost, loadUsage, type Tokens } from "./usage";
import { threadsTable } from "./state";

// The Stats page's numbers, one week at a time (Monday to Sunday in his time zone).
// GitHub: one repo at a time (Dryft-AI/app unless he picks another), one GraphQL call per repo and week (a 502 is tried twice more), cached in
// stats-github.json; a finished week is never fetched again and the current one at most every 15 minutes, since the token is shared with
// the sentries. Commits in a repo cloned here are counted from the clone, which costs no API call and sees every branch (maxflow's work
// lives on feat/v2, which GitHub's own count leaves out); elsewhere from the default branch's history.
// yarn: read from events.jsonl and the threads table, which only go back to when v2 started.

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
type Thread = { id: string; messages: Msg[]; objective?: string; routers?: string[] };

// Most of the log is screen reads; only these topics are parsed.
const WANTED = /"topic":"(signal\/isaac|signal-route\/|slack\/|thread\/|ask\/|wait\/|gh\/[^"]*\/(merged|opened)"|ram\/killed|claude-resync\/|server\/start|sentry\/start)/;

let parsed: { size: number; events: Ev[]; since: number; perDay: Map<string, number> } | undefined;
function events() {
  const file = `${STATE_DIR}/events.jsonl`;
  if (!existsSync(file)) return { events: [] as Ev[], since: Date.now(), perDay: new Map<string, number>() };
  const text = readFileSync(file, "utf8");
  if (parsed?.size === text.length) return parsed;
  const out: Ev[] = [];
  let since = Infinity;
  // How many events the bus carried each day, for the Performance tab.
  const perDay = new Map<string, number>();
  // Days turn over on the hour in every zone he's in, so the day of each hour is worked out once.
  const hourDay = new Map<number, string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const at = Number(line.match(/"at":(\d+)/)?.[1]);
    if (since === Infinity) since = at || Infinity;
    if (at) {
      const hour = Math.floor(at / 3600_000);
      const day = hourDay.get(hour) ?? hourDay.set(hour, dayKey(at)).get(hour)!;
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    if (!WANTED.test(line)) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  parsed = { size: text.length, events: out, since, perDay };
  return parsed;
}

const yarnCache = new Map<string, { at: number; value: YarnWeek }>();

export function yarn(w: Week): YarnWeek {
  const hit = yarnCache.get(w.key);
  if (hit && (hit.at > w.to || Date.now() - hit.at < 60_000)) return hit.value;
  const { events: evs, since } = events();
  const threads = threadsTable.read() as Thread[];
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

// ---- Overview: the contribution calendar

export type Calendar = { at: number; total: number; days: { date: string; count: number }[]; error?: string };
let calendarCache: Calendar | undefined;
let calendarLoad: Promise<Calendar> | undefined;

/** His GitHub contribution calendar for the last year, as his profile draws it: every repo, private ones counted without names.
 * One GraphQL call, at most once an hour. */
export function calendar(): Promise<Calendar> {
  if (calendarCache && !calendarCache.error && Date.now() - calendarCache.at < 3600_000) return Promise.resolve(calendarCache);
  return (calendarLoad ??= retried(`query { viewer { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }`)
    .then(d => {
      const cal = d.viewer.contributionsCollection.contributionCalendar;
      const days = (cal.weeks as { contributionDays: { date: string; contributionCount: number }[] }[]).flatMap(w => w.contributionDays.map(x => ({ date: x.date, count: x.contributionCount })));
      return (calendarCache = { at: Date.now(), total: cal.totalContributions, days });
    })
    .catch((e: Error) => {
      console.error(`stats: contribution calendar failed: ${e.message}`);
      return calendarCache ? { ...calendarCache, error: e.message } : { at: Date.now(), total: 0, days: [], error: e.message };
    })
    .finally(() => (calendarLoad = undefined)));
}

// ---- Performance: how the server and its sentries are doing

export type SessionInfo = { id: string; name: string; createdAt: number; running?: boolean; status?: string; archived?: boolean; asleep?: boolean; sentry?: boolean; agent?: boolean; role?: { role: string; objective: string } };

const lastDays = (n: number) => Array.from({ length: n }, (_, i) => dayKey(Date.now() - (n - 1 - i) * DAY));

export function health(sessions: SessionInfo[]) {
  const { events: evs, perDay, since } = events();
  // The bus log reaches back only so far; days before it would read as zeros.
  const days = lastDays(14).filter(d => d >= dayKey(since));
  const perDayOf = (topic: (t: string) => boolean) => {
    const counts = new Map<string, number>();
    for (const e of evs) if (topic(e.topic)) counts.set(dayKey(e.at), (counts.get(dayKey(e.at)) ?? 0) + 1);
    return days.map(d => counts.get(d) ?? 0);
  };
  // Deploys are the live checkout fast-forwarding; its reflog keeps when each one landed.
  const reflog = Bun.spawnSync(["git", "-C", DIR, "reflog", "--date=unix", "--format=%gd%x09%H%x09%gs", "-n", "300"], { stderr: "pipe" }).stdout.toString();
  const deploys = reflog
    .split("\n")
    .filter(l => l.includes("Fast-forward"))
    .map(l => {
      const [ref, sha] = l.split("\t");
      return { at: Number(ref!.match(/\{(\d+)\}/)?.[1]) * 1000, sha: sha!.slice(0, 7) };
    })
    .filter(d => d.at > Date.now() - 14 * DAY);
  const subjects = deploys.length ? Bun.spawnSync(["git", "-C", DIR, "show", "-s", "--format=%h%x09%s", ...deploys.map(d => d.sha)], { stderr: "pipe" }).stdout.toString() : "";
  const subject = new Map(subjects.split("\n").map(l => [l.slice(0, 7), l.slice(8)]));
  const starts = evs.filter(e => e.topic === "server/start").map(e => e.at);
  const respawns = new Map<string, number>();
  for (const e of evs) if (e.topic === "sentry/start" && e.data.why === "respawn" && e.at > Date.now() - 7 * DAY) respawns.set(e.data.name as string, (respawns.get(e.data.name as string) ?? 0) + 1);
  const agents = sessions.filter(s => s.agent && !s.sentry);
  return {
    days,
    server: { upSince: Date.now() - process.uptime() * 1000, rssMb: Math.round(process.memoryUsage().rss / 1e6), starts: starts.filter(at => at > Date.now() - 14 * DAY), logSince: starts[0] },
    deploys: deploys.map(d => ({ ...d, subject: subject.get(d.sha) ?? "" })),
    sentries: sessions
      .filter(s => s.sentry)
      .map(s => ({ name: s.name, running: !!s.running, upSince: s.createdAt, respawns: respawns.get(s.name) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sessions: {
      total: sessions.length,
      working: agents.filter(s => s.status === "working").length,
      idle: agents.filter(s => s.running && !s.archived && s.status !== "working").length,
      asleep: agents.filter(s => s.archived || s.asleep).length,
      shells: sessions.filter(s => !s.agent && !s.sentry).length,
    },
    events: days.map(d => perDay.get(d) ?? 0),
    ramKills: perDayOf(t => t.startsWith("ram/killed")),
    resyncs: perDayOf(t => t.startsWith("claude-resync/")),
  };
}

// ---- Agents: what they cost and what came of it

let usageScan: Bun.Subprocess | undefined;
/** Starts a background read of the transcripts when the sums are over two minutes old; true while one runs. */
function freshenUsage(at: number) {
  if (usageScan && usageScan.exitCode === null) return true;
  if (Date.now() - at < 120_000) return false;
  usageScan = Bun.spawn(["bun", `${DIR}/usage.ts`], { cwd: DIR, stdout: "ignore", stderr: "inherit" });
  return true;
}

let usageMemo: { at: number; value: ReturnType<typeof loadUsage> } | undefined;
const names = () => {
  try {
    return JSON.parse(readFileSync(`${STATE_DIR}/names.json`, "utf8")) as Record<string, string>;
  } catch {
    return {} as Record<string, string>;
  }
};

type Group = {
  id: string;
  name: string;
  kind: "agent" | "sentry" | "outside";
  objective?: string;
  role?: string;
  dollars: number;
  saved: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  messages: number;
  activeMs: number;
  first?: number;
  last?: number;
  models: Record<string, number>;
  prs: number;
  threads: number;
};

export function agents(windowDays: number, sessions: SessionInfo[], objectives: { id: string; title: string }[]) {
  const raw = existsSync(`${STATE_DIR}/stats-usage.json`) ? loadUsage() : { at: 0, files: {} };
  if (!usageMemo || usageMemo.at !== raw.at) usageMemo = { at: raw.at, value: raw };
  const usage = usageMemo.value;
  const scanning = freshenUsage(usage.at);
  const days = lastDays(windowDays);
  const inWindow = new Set(days);
  const from = midnight(days[0]!);
  const live = new Map(sessions.map(s => [s.id, s]));
  const named = names();

  // Every transcript joins its agent's group: a subagent's file its parent chat's, a chat outside yarn its folder's.
  const groups = new Map<string, Group>();
  // Per day and model: dollars and tokens.
  const daily = new Map<string, Record<string, [number, number]>>();
  const byModel = new Map<string, { dollars: number; tokens: number }>();
  for (const [path, f] of Object.entries(usage.files)) {
    const parent = f.parent ? usage.files[f.parent] : undefined;
    const yarnId = f.yarn ?? parent?.yarn;
    const s = yarnId ? live.get(yarnId) : undefined;
    const cwd = f.cwd ?? parent?.cwd ?? path.split("/").slice(-2, -1)[0]!;
    const name = yarnId ? (s?.name ?? named[yarnId] ?? f.name ?? parent?.name ?? yarnId) : cwd.replace(process.env.HOME ?? "", "~");
    const key = yarnId ?? `outside:${cwd}`;
    let g = groups.get(key);
    for (const [day, d] of Object.entries(f.days)) {
      if (!inWindow.has(day)) continue;
      g ??= groups.set(key, {
        id: yarnId ?? cwd,
        name,
        kind: !yarnId ? "outside" : s?.sentry || name.startsWith("sentry:") ? "sentry" : "agent",
        objective: s?.role?.objective ?? f.objective ?? parent?.objective,
        role: s?.role?.role ?? f.role ?? parent?.role,
        dollars: 0,
        saved: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        messages: 0,
        activeMs: 0,
        models: {},
        prs: 0,
        threads: 0,
      }).get(key)!;
      g.activeMs += d.activeMs;
      const perModel = (daily.get(day) ?? daily.set(day, {}).get(day)!);
      for (const [model, t] of Object.entries(d.models) as [string, Tokens][]) {
        const c = cost(model, t);
        g.dollars += c.dollars;
        g.saved += c.saved;
        g.tokens.input += t[0];
        g.tokens.output += t[1];
        g.tokens.cacheWrite += t[2] + t[3];
        g.tokens.cacheRead += t[4];
        g.messages += t[5];
        g.models[model] = (g.models[model] ?? 0) + c.dollars;
        const pm = (perModel[model] ??= [0, 0]);
        pm[0] += c.dollars;
        pm[1] += t[0] + t[1] + t[2] + t[3] + t[4];
        const m = byModel.get(model) ?? byModel.set(model, { dollars: 0, tokens: 0 }).get(model)!;
        m.dollars += c.dollars;
        m.tokens += t[0] + t[1] + t[2] + t[3] + t[4];
      }
    }
    if (g && f.first !== undefined) (g.first = Math.min(g.first ?? f.first, f.first)), (g.last = Math.max(g.last ?? f.last!, f.last!));
  }

  // What came of it: PRs merged that an agent was told of, and threads resolved that it routed, in the window.
  const { events: evs } = events();
  const merged = new Map<string, string[]>();
  const resolvedAt = new Map<string, number>();
  for (const e of evs) {
    if (e.at < from) continue;
    if (e.topic.startsWith("gh/") && e.topic.endsWith("/merged") && !merged.has(e.data.pr as string)) merged.set(e.data.pr as string, (e.data.told as string[]) ?? []);
    else if (e.topic.startsWith("thread/") && "resolved" in e.data) {
      if (e.data.resolved) resolvedAt.set(e.data.thread as string, e.at);
      else resolvedAt.delete(e.data.thread as string);
    }
  }
  for (const told of merged.values()) for (const id of told) if (groups.has(id)) groups.get(id)!.prs++;
  const threads = threadsTable.read() as Thread[];
  for (const t of threads) if (resolvedAt.has(t.id)) for (const id of t.routers ?? []) if (groups.has(id)) groups.get(id)!.threads++;

  const all = [...groups.values()];
  const title = new Map(objectives.map(o => [o.id, o.title]));
  const byObjective = new Map<string, { id: string; title: string; dollars: number; agents: number; activeMs: number; prs: Set<string>; threads: number }>();
  for (const g of all) {
    if (!g.objective) continue;
    const o = byObjective.get(g.objective) ?? byObjective.set(g.objective, { id: g.objective, title: title.get(g.objective) ?? g.objective, dollars: 0, agents: 0, activeMs: 0, prs: new Set(), threads: 0 }).get(g.objective)!;
    o.dollars += g.dollars;
    o.agents++;
    o.activeMs += g.activeMs;
  }
  for (const [pr, told] of merged) for (const id of told) {
    const o = groups.get(id)?.objective;
    if (o) byObjective.get(o)?.prs.add(pr);
  }
  for (const t of threads) if (resolvedAt.has(t.id) && t.objective) {
    const o = byObjective.get(t.objective);
    if (o) o.threads++;
  }
  const sum = (f: (g: Group) => number) => all.reduce((n, g) => n + f(g), 0);
  const yarnSpend = sum(g => (g.kind === "outside" ? 0 : g.dollars));
  return {
    at: usage.at,
    scanning,
    days,
    activeGapMin: ACTIVE_GAP_MS / 60_000,
    totals: {
      dollars: sum(g => g.dollars),
      saved: sum(g => g.saved),
      input: sum(g => g.tokens.input),
      output: sum(g => g.tokens.output),
      cacheRead: sum(g => g.tokens.cacheRead),
      cacheWrite: sum(g => g.tokens.cacheWrite),
      messages: sum(g => g.messages),
      activeMs: sum(g => g.activeMs),
      agents: all.filter(g => g.kind === "agent").length,
      yarnDollars: yarnSpend,
      prs: merged.size,
      threads: resolvedAt.size,
    },
    daily: days.map(d => ({ day: d, models: daily.get(d) ?? {} })),
    models: [...byModel].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.dollars - a.dollars),
    groups: all.sort((a, b) => b.dollars - a.dollars),
    objectives: [...byObjective.values()].map(o => ({ ...o, prs: o.prs.size })).sort((a, b) => b.dollars - a.dollars),
  };
}
