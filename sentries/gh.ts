#!/usr/bin/env bun
// gh sentry: one poller for every PR any maxflow session cares about. Publishes changes as gh/<owner>/<repo>/pr/<n>/<kind>
// events and notifies the linked sessions when CI finishes, someone reviews or comments, or the PR merges, closes or conflicts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const WATCH_FILE = join(STATE_DIR, "gh-watch.json");
const STATE_FILE = join(STATE_DIR, "gh-state.json");
// The last poll of each PR, whole, so `maxflow gh status` can answer without asking GitHub.
const STATUS_FILE = join(STATE_DIR, "gh-status.json");
// This sentry's graph edges, one per tied session, labeled by its PRs.
const EDGES_FILE = join(STATE_DIR, "gh-edges.json");
// The PRs sentry:review lists, with the sessions on each; watched here like explicit watches.
export const REVIEW_WATCH_FILE = join(STATE_DIR, "review-watch.json");
const PROJECTS = join(process.env.HOME!, ".claude", "projects");
const INTERVAL_MS = Number(process.env.GH_SENTRY_INTERVAL ?? 30_000);
const CLI = new URL("../cli.ts", import.meta.url).pathname;
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;
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

const FIELDS = `number url title state createdAt mergeable reviewDecision headRefOid headRefName
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } }
  reviews(last: 30) { nodes { id state body author { login } } }
  comments(last: 30) { nodes { id body url author { login } } }
  reviewThreads(last: 50) { nodes { isResolved comments(last: 10) { nodes { id body path url author { login } } } } }`;

type Pr = {
  number: number; url: string; title: string; state: string; createdAt: string; mergeable: string; reviewDecision: string | null; headRefOid: string; headRefName: string;
  commits: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: { __typename: string; name?: string; conclusion?: string; context?: string; state?: string }[] } } | null } }[] };
  reviews: { nodes: { id: string; state: string; body: string; author: { login: string } | null }[] };
  comments: { nodes: { id: string; body: string; url: string; author: { login: string } | null }[] };
  reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: { id: string; body: string; path: string; url: string; author: { login: string } | null }[] } }[] };
};

// One GraphQL request per repo, covering the PRs watched by number and the ones found by branch.
export function fetchPrs(repo: string, numbers: number[], branches: string[]) {
  const [owner, name] = repo.split("/");
  const parts = [
    ...numbers.map((n) => `n${n}: pullRequest(number: ${n}) { ...F }`),
    ...branches.map((b, i) => `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...F } }`),
  ];
  const q = `query { r: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${parts.join("\n")} } }\nfragment F on PullRequest { ${FIELDS} }`;
  const out = run(["gh", "api", "graphql", "-f", `query=${q}`]);
  if (!out) return { byNumber: new Map<number, Pr>(), byBranch: new Map<string, Pr>() };
  const r = JSON.parse(out).data.r as Record<string, any>;
  return {
    byNumber: new Map(numbers.flatMap((n) => (r[`n${n}`] ? [[n, r[`n${n}`] as Pr]] : []))),
    byBranch: new Map(branches.flatMap((b, i) => (r[`b${i}`]?.nodes[0] ? [[b, r[`b${i}`].nodes[0] as Pr]] : []))),
  };
}

export type Link = { pr?: string; repo: string; branch?: string; session: string };

// The repo for a bare PR number declared outside a checkout: the one whose PR of that number the session mentioned last, else the one it mentions most.
function linkedRepo(urls: string[], ref: string) {
  const prs = urls.flatMap((u) => u.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)?.slice(1) ?? []);
  const repos = prs.filter((_, i) => i % 2 === 0).map((r) => r.toLowerCase());
  const exact = repos.findLast((_, i) => prs[i * 2 + 1] === ref.replace("#", ""));
  return exact ?? repos.sort((a, b) => repos.filter((r) => r === b).length - repos.filter((r) => r === a).length)[0] ?? "";
}

// Which PR each live session is on: explicit watches, the branch checked out in its cwd, and set-pr.sh declarations.
export async function links(): Promise<Link[]> {
  const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as { id: string; name: string; cwd: string; running: boolean; sentry: boolean; chatId?: string; transcript?: string; links?: string[] }[];
  const live = sessions.filter((s) => s.running && !s.sentry);
  const found: Link[] = [];
  for (const w of readWatches()) for (const session of w.sessions.length ? w.sessions : [""]) found.push({ pr: w.pr, repo: w.pr.split("#")[0], session });
  for (const s of live) {
    const cwd = run(["tmux", "-L", "maxflow", "display-message", "-p", "-t", `mf-${s.id}`, "#{pane_current_path}"]) || s.cwd;
    const repo = repoOf(cwd);
    const branch = repo && run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch && !["HEAD", "main", "master"].includes(branch)) found.push({ repo, branch, session: s.id });
    // A fresh chat's id is only known from the transcript path its hooks report.
    const chatId = s.chatId ?? s.transcript?.match(/([\w-]+)\.jsonl$/)?.[1];
    const declared = chatId ? join(process.env.HOME!, ".claude", "session-env", chatId, "pr") : "";
    if (declared && existsSync(declared))
      for (const ref of readFileSync(declared, "utf8").split("\n").filter(Boolean)) {
        const pr = parsePr(ref.trim(), cwd) ?? parsePr(ref.trim().replace(/^#?(\d+)$/, `${linkedRepo(s.links ?? [], ref.trim())}#$1`), cwd);
        if (pr) found.push({ pr, repo: pr.split("#")[0], session: s.id });
      }
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
    changes.push(["ci", { state: rollup!.state, sha: pr.headRefOid, failed }, rollup!.state === "SUCCESS" ? "CI passed" : `CI failed: ${failed.join(", ") || rollup!.state}`]);
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

function snapshot(pr: Pr): PrState {
  return {
    head: pr.headRefOid,
    ci: `${pr.headRefOid}:${pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? ""}`,
    state: pr.state,
    mergeable: pr.mergeable,
    decision: pr.reviewDecision ?? "",
    seen: [...pr.reviews.nodes.map((r) => r.id), ...pr.comments.nodes.map((c) => c.id), ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes.map((c) => c.id))],
  };
}

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: caller, body: JSON.stringify(body) });

async function tick(me: string, state: Record<string, PrState>) {
  const all = await links();
  for (const w of readJson<Watch[]>(REVIEW_WATCH_FILE, [])) for (const session of w.sessions.length ? w.sessions : [""]) all.push({ pr: w.pr, repo: w.pr.split("#")[0], session });
  const repos = new Map<string, { numbers: Set<number>; branches: Set<string> }>();
  for (const l of all) {
    const r = repos.get(l.repo) ?? repos.set(l.repo, { numbers: new Set(), branches: new Set() }).get(l.repo)!;
    if (l.pr) r.numbers.add(Number(l.pr.split("#")[1]));
    if (l.branch) r.branches.add(l.branch);
  }
  const listeners = new Map<string, Set<string>>();
  const prs = new Map<string, Pr>();
  for (const [repo, { numbers, branches }] of repos) {
    const { byNumber, byBranch } = fetchPrs(repo, [...numbers], [...branches]);
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
    state[key] = snapshot(pr);
    const told = [...(listeners.get(key) ?? [])];
    for (const [kind, data] of changes) await post("/api/events", { topic: `gh/${repo}/pr/${n}/${kind}`, data: { pr: key, told, ...(data as object) } });
    const lines = changes.flatMap(([, , line]) => (line ? [line] : []));
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
  for (const [key, sessions] of listeners) for (const s of sessions) (onPrs.get(s) ?? onPrs.set(s, []).get(s)!).push(`#${key.split("#")[1]}`);
  writeFileSync(EDGES_FILE, JSON.stringify([...onPrs].map(([session, prs]) => ({ session, label: prs.length > 2 ? `${prs.slice(0, 2).join(" ")} +${prs.length - 2}` : prs.join(" ") }))));
  writeFileSync(STATUS_FILE, JSON.stringify(Object.fromEntries([...prs].map(([key, pr]) => [key, { at: Date.now(), pr }]))));
  return prs.size;
}

export const readStatus = () => readJson<Record<string, { at: number; pr: Pr }>>(STATUS_FILE, {});

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
    await Bun.sleep(INTERVAL_MS);
  }
}
