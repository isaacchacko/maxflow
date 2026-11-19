#!/usr/bin/env bun
// gh sentry: one poller for every PR any maxflow session cares about. Publishes changes as gh/<owner>/<repo>/pr/<n>/<kind>
// events and notifies the linked sessions when CI finishes, someone reviews or comments, or the PR merges, closes or conflicts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE as base, STATE_DIR, TMUX_SOCKET } from "../instance";
import { ghStatusTable } from "../state";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("gh");

const WATCH_FILE = join(STATE_DIR, "gh-watch.json");
const STATE_FILE = join(STATE_DIR, "gh-state.json");
// The last poll of each PR, whole, so `maxflow gh status` can answer without asking GitHub.
// This sentry's graph edges, one per tied session, labeled by its PRs.
const EDGES_FILE = join(STATE_DIR, "gh-edges.json");
// The PRs sentry:review lists, with the sessions on each; watched here like explicit watches.
export const REVIEW_WATCH_FILE = join(STATE_DIR, "review-watch.json");
// The PRs requesting the user's review or assigned to him, which sentry:inbox lists; watched the same way.
export const INBOX_WATCH_FILE = join(STATE_DIR, "inbox-watch.json");
const PROJECTS = join(process.env.HOME!, ".claude", "projects");
const INTERVAL_MS = Number(process.env.GH_SENTRY_INTERVAL ?? 30_000);
const CLI = new URL("../cli.ts", import.meta.url).pathname;
// Sent with each call that touches a session, so the graph draws this sentry doing it.
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };

export type Watch = { pr: string; sessions: string[] };
type PrState = { head: string; ci: string; state: string; mergeable: string; decision: string; seen: string[] };

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
export const readWatches = () => readJson<Watch[]>(WATCH_FILE, []);
export const writeWatches = (w: Watch[]) => writeFileSync(WATCH_FILE, JSON.stringify(w, null, 2));

function run(cmd: string[], cwd?: string) {
  const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

export function repoOf(cwd: string) {
  return run(["git", "-C", cwd, "remote", "get-url", "origin"]).match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1].toLowerCase() ?? "";
}

// Accepts a PR url, owner/repo#n, or a bare n / #n resolved against the repo checked out in `cwd`.
export function parsePr(ref: string, cwd: string) {
  const url = ref.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (url) return `${url[1].toLowerCase()}#${url[2]}`;
  const full = ref.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (full) return `${full[1].toLowerCase()}#${full[2]}`;
  const bare = ref.match(/^#?(\d+)$/);
  const repo = bare && repoOf(cwd);
  return repo ? `${repo}#${bare![1]}` : null;
}

// author (a User or a Bot) and authorAssociation: whose PR it is, for restrictions scoped to people (hooks/restrictions.ts reads them from the gh_status table).
const FIELDS = `number url title state createdAt updatedAt mergeable reviewDecision headRefOid headRefName author { __typename login } authorAssociation
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } }
  reviews(last: 30) { nodes { id state body author { login } } }
  comments(last: 30) { nodes { id body url author { login } } }
  reviewThreads(last: 50) { nodes { isResolved comments(last: 10) { nodes { id body path url author { login } } } } }`;

type Pr = {
  number: number; url: string; title: string; state: string; createdAt: string; updatedAt?: string; mergeable: string; reviewDecision: string | null; headRefOid: string; headRefName: string;
  author: { __typename: string; login: string } | null; authorAssociation: string;
  commits: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: { __typename: string; name?: string; conclusion?: string; context?: string; state?: string }[] } } | null } }[] };
  reviews: { nodes: { id: string; state: string; body: string; author: { login: string } | null }[] };
  comments: { nodes: { id: string; body: string; url: string; author: { login: string } | null }[] };
  reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: { id: string; body: string; path: string; url: string; author: { login: string } | null }[] } }[] };
};

// Set when GitHub answers with a rate limit, so the loop backs off instead of spending what's left of the hour.
let limited = false;
function graphql(repo: string, q: string, what: string) {
  const res = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${q}`], { stderr: "pipe" });
  const err = res.stderr.toString().trim();
  if (res.exitCode !== 0) console.error(`${new Date().toLocaleTimeString()}  ${repo}: graphql failed for ${what}: ${err.slice(0, 300)}`);
  if (/rate limit/i.test(err)) limited = true;
  // One PR number that doesn't resolve makes gh exit 1, but the rest of the data still comes back.
  try { return (JSON.parse(res.stdout.toString()).data?.r ?? {}) as Record<string, any>; } catch { return {}; }
}

function query(repo: string, numbers: number[], branches: string[], fragment: string, chunk: number) {
  const [owner, name] = repo.split("/");
  const parts = [
    ...numbers.map((n) => `n${n}: pullRequest(number: ${n}) { ...F }`),
    ...branches.map((b, i) => `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...F } }`),
  ];
  const r: Record<string, any> = {};
  for (let i = 0; i < parts.length; i += chunk) {
    const q = `query { r: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${parts.slice(i, i + chunk).join("\n")} } }\nfragment F on PullRequest { ${fragment} }`;
    Object.assign(r, graphql(repo, q, parts.length > chunk ? `chunk ${i / chunk + 1}` : "its PRs"));
  }
  return {
    byNumber: new Map(numbers.flatMap((n) => (r[`n${n}`] ? [[n, r[`n${n}`]]] : []))),
    byBranch: new Map(branches.flatMap((b, i) => (r[`b${i}`]?.nodes[0] ? [[b, r[`b${i}`].nodes[0]]] : []))),
  };
}

// A repo's PRs watched by number and found by branch, asked 20 at a time: one query for ~80 runs into GitHub's 10s GraphQL timeout and comes back empty.
// 20 PRs cost 11 of the token's 5,000 GraphQL points an hour, mostly for the review threads' comments, so the sentry asks this only of PRs that changed.
export const fetchPrs = (repo: string, numbers: number[], branches: string[]) =>
  query(repo, numbers, branches, FIELDS, 20) as { byNumber: Map<number, Pr>; byBranch: Map<string, Pr> };

// What moves when anything worth a notice happens: a comment or review bumps updatedAt; a push, CI, a merge or the base moving shows in the rest.
// 100 PRs of this cost 1 point.
const HEAD = `number updatedAt state mergeable reviewDecision headRefOid commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;
type Head = { number: number; updatedAt: string; state: string; mergeable: string; reviewDecision: string | null; headRefOid: string; commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } };
export const fetchHeads = (repo: string, numbers: number[], branches: string[]) =>
  query(repo, numbers, branches, HEAD, 100) as { byNumber: Map<number, Head>; byBranch: Map<string, Head> };
const signature = (p: Head | Pr) => [p.updatedAt, p.state, p.mergeable, p.reviewDecision, p.headRefOid, p.commits.nodes[0]?.commit.statusCheckRollup?.state].join(" ");

export type Link = { pr?: string; repo: string; branch?: string; session: string };

// Which PR each live session is on: explicit watches and the branch checked out in its cwd.
export async function links(): Promise<Link[]> {
  const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as { id: string; name: string; cwd: string; running: boolean; sentry: boolean }[];
  const live = sessions.filter((s) => s.running && !s.sentry);
  const found: Link[] = [];
  for (const w of readWatches()) for (const session of w.sessions.length ? w.sessions : [""]) found.push({ pr: w.pr, repo: w.pr.split("#")[0], session });
  for (const s of live) {
    const cwd = run(["tmux", "-L", TMUX_SOCKET, "display-message", "-p", "-t", `mf-${s.id}`, "#{pane_current_path}"]) || s.cwd;
    const repo = repoOf(cwd);
    const branch = repo && run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch && !["HEAD", "main", "master"].includes(branch)) found.push({ repo, branch, session: s.id });
  }
  return found;
}

// The agents post as the gh user too, so a comment by that user is the user's own only when no agent's tool call carries its text.
const scanned = new Map<string, { offset: number; calls: string[] }>();
async function agentCalls() {
  const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as { name: string; sentry: boolean; chatId?: string; transcript?: string }[];
  const calls: string[] = [];
  for (const s of sessions.filter((s) => !s.sentry)) {
    const path = s.transcript ?? (s.chatId ? [...new Bun.Glob(`*/${s.chatId}.jsonl`).scanSync(PROJECTS)].map((f) => join(PROJECTS, f))[0] : undefined);
    if (!path || !existsSync(path)) continue;
    const memo = scanned.get(path) ?? scanned.set(path, { offset: 0, calls: [] }).get(path)!;
    const fresh = readFileSync(path).subarray(memo.offset);
    const end = fresh.lastIndexOf(10) + 1;
    memo.offset += end;
    memo.calls.push(...fresh.subarray(0, end).toString().split("\n").filter((l) => l.includes('"tool_use"')));
    calls.push(...memo.calls);
  }
  return calls;
}

// Stretches of the body that survive shell quoting, JSON escaping and a substituted $sha unchanged.
function probes(body: string) {
  const runs = body.slice(0, 600).match(/[^"'`$\\\x00-\x1f0-9]{20,}/g) ?? [];
  return runs.map((r) => r.trim().slice(0, 80)).sort((a, b) => b.length - a.length).slice(0, 5);
}

const short = (text: string, n = 300) => (text.replace(/\s+/g, " ").trim().slice(0, n) + (text.length > n ? "…" : "")).trim();
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);

// Compares a PR to what the last tick saw. Returns [kind, data, line for the agent or null to only publish].
// A review or comment's `who` is null for an agent's own post.
function diff(pr: Pr, prev: PrState | undefined, me: string, byAgent: (body: string) => boolean): [string, unknown, string | null][] {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  const changes: [string, unknown, string | null][] = [];
  if (!prev) {
    if (Date.now() - Date.parse(pr.createdAt) < 10 * 60_000) changes.push(["opened", { url: pr.url, title: pr.title }, null]);
    return changes;
  }
  if (pr.headRefOid !== prev.head) changes.push(["push", { sha: pr.headRefOid }, null]);
  const ci = `${pr.headRefOid}:${rollup?.state ?? ""}`;
  if (ci !== prev.ci && (rollup?.state === "SUCCESS" || FAILED.has(rollup?.state ?? ""))) {
    const failed = rollup!.contexts.nodes.filter((c) => FAILED.has(c.conclusion ?? c.state ?? "")).map((c) => c.name ?? c.context!);
    // Named by its commit, so CI on each new push doesn't read as the same notice twice.
    const on = pr.headRefOid.slice(0, 7);
    changes.push(["ci", { state: rollup!.state, sha: pr.headRefOid, failed }, rollup!.state === "SUCCESS" ? `CI passed on ${on}` : `CI failed on ${on}: ${failed.join(", ") || rollup!.state}`]);
  }
  if (pr.state !== prev.state) changes.push([pr.state.toLowerCase(), { url: pr.url }, pr.state === "OPEN" ? "reopened" : pr.state.toLowerCase()]);
  if (pr.mergeable === "CONFLICTING" && prev.mergeable !== "CONFLICTING") changes.push(["conflict", {}, "now conflicts with its base branch"]);
  if ((pr.reviewDecision ?? "") !== prev.decision) changes.push(["decision", { decision: pr.reviewDecision }, null]);
  const seen = new Set(prev.seen);
  // Agents' own posts are published but never echoed back to them; the user's own comments are passed on.
  const tell = (login: string | undefined, body: string) => (!login ? null : login !== me ? login : byAgent(body) ? null : `the user (${me})`);
  for (const r of pr.reviews.nodes)
    if (!seen.has(r.id) && r.state !== "PENDING") {
      const who = r.author?.login === me && !r.body.trim() ? null : tell(r.author?.login, r.body);
      changes.push(["review", { id: r.id, author: r.author?.login, state: r.state, body: r.body, who }, who && `review from ${who}: ${r.state.toLowerCase().replace("_", " ")}${r.body ? ` "${short(r.body)}"` : ""}`]);
    }
  for (const c of pr.comments.nodes)
    if (!seen.has(c.id)) {
      const who = tell(c.author?.login, c.body);
      changes.push(["comment", { id: c.id, author: c.author?.login, body: c.body, url: c.url, who }, who && `comment from ${who}: "${short(c.body)}" ${c.url}`]);
    }
  for (const t of pr.reviewThreads.nodes)
    for (const c of t.comments.nodes)
      if (!seen.has(c.id)) {
        const who = tell(c.author?.login, c.body);
        changes.push(["thread", { id: c.id, author: c.author?.login, path: c.path, body: c.body, url: c.url, who }, who && `comment from ${who} on ${c.path}: "${short(c.body)}" ${c.url}`]);
      }
  return changes;
}

function hasOwnNew(pr: Pr, prev: PrState, me: string) {
  const seen = new Set(prev.seen);
  return [...pr.reviews.nodes, ...pr.comments.nodes, ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes)].some((c) => !seen.has(c.id) && c.author?.login === me);
}

// ci keeps the last finished result announced, so a rollup that dips back to pending on the same head (a re-run, a late check) and lands
// on the same result isn't announced again. mergeable keeps the last known answer through UNKNOWN, which GitHub gives while it
// recomputes after the base moves: otherwise every merge to main announced each conflicting PR's conflict again.
function snapshot(pr: Pr, prev?: PrState): PrState {
  const ci = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? "";
  return {
    head: pr.headRefOid,
    ci: ci === "SUCCESS" || FAILED.has(ci) ? `${pr.headRefOid}:${ci}` : (prev?.ci ?? ""),
    state: pr.state,
    mergeable: pr.mergeable === "UNKNOWN" ? (prev?.mergeable ?? "UNKNOWN") : pr.mergeable,
    decision: pr.reviewDecision ?? "",
    seen: [...pr.reviews.nodes.map((r) => r.id), ...pr.comments.nodes.map((c) => c.id), ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes.map((c) => c.id))],
  };
}

// 👀 on the user's own comment or review once the funnel has been handed it, so he can see on GitHub that it was read.
export const ownComment = (who: string | null | undefined) => !!who?.startsWith("the user");
export async function markRead(id: string) {
  const p = Bun.spawn(["gh", "api", "graphql", "-f", `query=mutation { addReaction(input: { subjectId: ${JSON.stringify(id)}, content: EYES }) { clientMutationId } }`], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) console.error(`${new Date().toLocaleTimeString()}  👀 on ${id} failed: ${(await new Response(p.stderr).text()).trim().slice(0, 300)}`);
}

// The last whole fetch of each PR, kept across restarts in the gh_status table.
const cache = new Map<string, { at: number; pr: Pr }>(Object.entries(ghStatusTable.all()));

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: caller, body: JSON.stringify(body) });

async function tick(me: string, state: Record<string, PrState>) {
  const all = await links();
  for (const w of [...readJson<Watch[]>(REVIEW_WATCH_FILE, []), ...readJson<Watch[]>(INBOX_WATCH_FILE, [])]) for (const session of w.sessions.length ? w.sessions : [""]) all.push({ pr: w.pr, repo: w.pr.split("#")[0], session });
  const repos = new Map<string, { numbers: Set<number>; branches: Set<string> }>();
  for (const l of all) {
    const r = repos.get(l.repo) ?? repos.set(l.repo, { numbers: new Set(), branches: new Set() }).get(l.repo)!;
    if (l.pr) r.numbers.add(Number(l.pr.split("#")[1]));
    if (l.branch) r.branches.add(l.branch);
  }
  const listeners = new Map<string, Set<string>>();
  const prs = new Map<string, Pr>();
  for (const [repo, { numbers, branches }] of repos) {
    const heads = fetchHeads(repo, [...numbers], [...branches]);
    const found = [...heads.byNumber.values(), ...heads.byBranch.values()];
    // A PR is fetched whole when it changed, and every few minutes anyway: the rollup stays PENDING while single checks finish.
    const stale = [...new Set(found.flatMap((h) => {
      const had = cache.get(`${repo}#${h.number}`);
      const ci = h.commits.nodes[0]?.commit.statusCheckRollup?.state ?? "SUCCESS";
      const pending = ci !== "SUCCESS" && !FAILED.has(ci);
      return !had || signature(had.pr) !== signature(h) || Date.now() - had.at > (pending ? 2 : 10) * 60_000 ? [h.number] : [];
    }))];
    for (const pr of fetchPrs(repo, stale, []).byNumber.values()) cache.set(`${repo}#${pr.number}`, { at: Date.now(), pr });
    const full = (h: Head) => cache.get(`${repo}#${h.number}`)?.pr;
    const byNumber = new Map([...heads.byNumber].flatMap(([n, h]) => (full(h) ? [[n, full(h)!]] : [])));
    const byBranch = new Map([...heads.byBranch].flatMap(([b, h]) => (full(h) ? [[b, full(h)!]] : [])));
    for (const pr of [...byNumber.values(), ...byBranch.values()]) prs.set(`${repo}#${pr.number}`, pr);
    for (const l of all.filter((l) => l.repo === repo)) {
      const pr = l.pr ? byNumber.get(Number(l.pr.split("#")[1])) : byBranch.get(l.branch!);
      if (!pr || !l.session) continue;
      const key = `${repo}#${pr.number}`;
      (listeners.get(key) ?? listeners.set(key, new Set()).get(key)!).add(l.session);
    }
  }
  let calls: string[] | undefined;
  const byAgent = (body: string) => {
    const ps = probes(body);
    return !!calls?.some((c) => ps.some((p) => c.includes(p)));
  };
  for (const [key, pr] of prs) {
    const [repo, n] = key.split("#");
    if (!calls && state[key] && hasOwnNew(pr, state[key], me)) calls = await agentCalls();
    const changes = diff(pr, state[key], me, byAgent);
    state[key] = snapshot(pr, state[key]);
    const told = [...(listeners.get(key) ?? [])];
    for (const [kind, data] of changes) await post("/api/events", { topic: `gh/${repo}/pr/${n}/${kind}`, data: { pr: key, told, ...(data as object) } });
    // The user's own comments go to the funnel as his asks, from the server; telling the PR's sessions too would deliver them twice.
    const lines = changes.flatMap(([, data, line]) => (line && !ownComment((data as { who?: string }).who) ? [line] : []));
    if (lines.length) {
      const more = lines.length > 5 ? `; and ${lines.length - 5} more` : "";
      const text = `[maxflow gh] ${key} (${short(pr.title, 60)}): ${lines.slice(0, 5).join("; ")}${more}. Full status: ${CLI} gh status ${key}. (Automated notice, not a request from the user: act on it only if it's part of your current task.)`;
      for (const session of listeners.get(key) ?? []) await post(`/api/sessions/${session}/notify`, { text });
      console.log(`${new Date().toLocaleTimeString()}  ${text}  -> ${[...(listeners.get(key) ?? [])].join(", ") || "nobody"}`);
    }
  }
  // Explicit watches end with the PR.
  const done = new Set([...prs].filter(([, pr]) => pr.state !== "OPEN").map(([key]) => key));
  const watches = readWatches();
  if (watches.some((w) => done.has(w.pr))) writeWatches(watches.filter((w) => !done.has(w.pr)));
  writeFileSync(STATE_FILE, JSON.stringify(state));
  const onPrs = new Map<string, string[]>();
  for (const [key, sessions] of listeners) for (const s of sessions) (onPrs.get(s) ?? onPrs.set(s, []).get(s)!).push(key);
  const label = (prs: string[]) => prs.map((k) => `#${k.split("#")[1]}`);
  writeFileSync(EDGES_FILE, JSON.stringify([...onPrs].map(([session, prs]) => ({ session, prs, label: prs.length > 2 ? `${label(prs).slice(0, 2).join(" ")} +${prs.length - 2}` : label(prs).join(" ") }))));
  ghStatusTable.write(Object.fromEntries([...prs].map(([key, pr]) => [key, { at: cache.get(key)?.at ?? Date.now(), pr }])));
  return prs.size;
}

export const readStatus = () => ghStatusTable.all() as Record<string, { at: number; pr: Pr }>;

// What an agent would otherwise run gh pr view / gh pr checks for, as plain text.
export function render(key: string, pr: Pr, at: number) {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  const checks = rollup?.contexts.nodes.map((c) => ({ name: c.name ?? c.context!, result: c.conclusion ?? c.state ?? "PENDING" })) ?? [];
  const failed = checks.filter((c) => FAILED.has(c.result)).map((c) => c.name);
  const pending = checks.filter((c) => !c.result || ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS"].includes(c.result)).map((c) => c.name);
  const latest = new Map(pr.reviews.nodes.filter((r) => r.state !== "COMMENTED" && r.state !== "PENDING").map((r) => [r.author?.login ?? "?", r.state.toLowerCase().replace("_", " ")]));
  const open = pr.reviewThreads.nodes.filter((t) => !t.isResolved && t.comments.nodes.length);
  return [
    `${key}  ${pr.state.toLowerCase()} · ${pr.mergeable.toLowerCase()} · ${(pr.reviewDecision ?? "no review decision").toLowerCase().replace(/_/g, " ")}  (polled ${Math.round((Date.now() - at) / 1000)}s ago)`,
    `${pr.title}  ${pr.url}`,
    `CI ${rollup?.state ?? "none"} on ${pr.headRefOid.slice(0, 7)}: ${checks.length - failed.length - pending.length} passed, ${failed.length} failed, ${pending.length} pending`,
    ...(failed.length ? [`  failed: ${failed.join(", ")}`] : []),
    ...(pending.length ? [`  pending: ${pending.join(", ")}`] : []),
    `reviews: ${[...latest].map(([who, state]) => `${who} ${state}`).join("; ") || "none"}`,
    `unresolved threads: ${open.length}`,
    ...open.map((t) => { const c = t.comments.nodes.at(-1)!; return `  ${c.path}  ${c.author?.login}: "${short(c.body, 200)}" ${c.url}`; }),
    ...(pr.comments.nodes.length ? ["latest comments:", ...pr.comments.nodes.slice(-3).map((c) => `  ${c.author?.login}: "${short(c.body, 200)}" ${c.url}`)] : []),
  ].join("\n");
}

if (import.meta.main) {
  const me = run(["gh", "api", "user", "-q", ".login"]);
  const state = readJson<Record<string, PrState>>(STATE_FILE, {});
  console.log(`gh sentry as ${me || "?"}, every ${INTERVAL_MS / 1000}s`);
  for (;;) {
    try {
      const n = await tick(me, state);
      process.title = `gh sentry (${n} PRs)`;
    } catch (e) {
      console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
    }
    // GitHub's limits reset hourly; a rate-limited sentry waits 5 minutes rather than keep failing every 30s.
    await Bun.sleep(limited ? 5 * 60_000 : INTERVAL_MS);
    limited = false;
  }
}
