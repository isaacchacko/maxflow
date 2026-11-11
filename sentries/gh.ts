#!/usr/bin/env bun
// gh sentry: one poller for every PR any maxflow session cares about. Publishes changes as gh/<owner>/<repo>/pr/<n>/<kind>
// events and notifies the linked sessions when CI finishes, someone reviews or comments, or the PR merges, closes or conflicts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const WATCH_FILE = join(STATE_DIR, "gh-watch.json");
const STATE_FILE = join(STATE_DIR, "gh-state.json");
const INTERVAL_MS = Number(process.env.GH_SENTRY_INTERVAL ?? 30_000);
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

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

const FIELDS = `number url title state createdAt mergeable reviewDecision headRefOid
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } }
  reviews(last: 30) { nodes { id state body author { login } } }
  comments(last: 30) { nodes { id body url author { login } } }
  reviewThreads(last: 50) { nodes { comments(last: 10) { nodes { id body path url author { login } } } } }`;

type Pr = {
  number: number; url: string; title: string; state: string; createdAt: string; mergeable: string; reviewDecision: string | null; headRefOid: string;
  commits: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: { __typename: string; name?: string; conclusion?: string; context?: string; state?: string }[] } } | null } }[] };
  reviews: { nodes: { id: string; state: string; body: string; author: { login: string } | null }[] };
  comments: { nodes: { id: string; body: string; url: string; author: { login: string } | null }[] };
  reviewThreads: { nodes: { comments: { nodes: { id: string; body: string; path: string; url: string; author: { login: string } | null }[] } }[] };
};

// One GraphQL request per repo, covering the PRs watched by number and the ones found by branch.
function fetchPrs(repo: string, numbers: number[], branches: string[]) {
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

type Link = { pr?: string; repo: string; branch?: string; session: string };

// Which PR each live session is on: explicit watches, the branch checked out in its cwd, and set-pr.sh declarations.
async function links(): Promise<Link[]> {
  const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as { id: string; name: string; cwd: string; running: boolean; chatId?: string }[];
  const live = sessions.filter((s) => s.running && !s.name.startsWith("sentry:"));
  const found: Link[] = [];
  for (const w of readWatches()) for (const session of w.sessions.length ? w.sessions : [""]) found.push({ pr: w.pr, repo: w.pr.split("#")[0], session });
  for (const s of live) {
    const cwd = run(["tmux", "-L", "maxflow", "display-message", "-p", "-t", `mf-${s.id}`, "#{pane_current_path}"]) || s.cwd;
    const repo = repoOf(cwd);
    if (!repo) continue;
    const branch = run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch && !["HEAD", "main", "master"].includes(branch)) found.push({ repo, branch, session: s.id });
    const declared = s.chatId ? join(process.env.HOME!, ".claude", "session-env", s.chatId, "pr") : "";
    if (declared && existsSync(declared))
      for (const ref of readFileSync(declared, "utf8").split("\n").filter(Boolean)) {
        const pr = parsePr(ref.trim(), cwd);
        if (pr) found.push({ pr, repo: pr.split("#")[0], session: s.id });
      }
  }
  return found;
}

const short = (text: string, n = 300) => (text.replace(/\s+/g, " ").trim().slice(0, n) + (text.length > n ? "…" : "")).trim();
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);

// Compares a PR to what the last tick saw. Returns [kind, data, line for the agent or null to only publish].
function diff(pr: Pr, prev: PrState | undefined, me: string): [string, unknown, string | null][] {
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
  // The agents post as `me` too, so their own replies are published but never echoed back to them.
  const tell = (login?: string) => (login && login !== me ? login : null);
  for (const r of pr.reviews.nodes)
    if (!seen.has(r.id) && r.state !== "PENDING") {
      const who = tell(r.author?.login);
      changes.push(["review", { id: r.id, author: r.author?.login, state: r.state, body: r.body }, who && `review from ${who}: ${r.state.toLowerCase().replace("_", " ")}${r.body ? ` "${short(r.body)}"` : ""}`]);
    }
  for (const c of pr.comments.nodes)
    if (!seen.has(c.id)) {
      const who = tell(c.author?.login);
      changes.push(["comment", { id: c.id, author: c.author?.login, body: c.body, url: c.url }, who && `comment from ${who}: "${short(c.body)}" ${c.url}`]);
    }
  for (const t of pr.reviewThreads.nodes)
    for (const c of t.comments.nodes)
      if (!seen.has(c.id)) {
        const who = tell(c.author?.login);
        changes.push(["thread", { id: c.id, author: c.author?.login, path: c.path, body: c.body, url: c.url }, who && `comment from ${who} on ${c.path}: "${short(c.body)}" ${c.url}`]);
      }
  return changes;
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

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

async function tick(me: string, state: Record<string, PrState>) {
  const all = await links();
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
  for (const [key, pr] of prs) {
    const [repo, n] = key.split("#");
    const changes = diff(pr, state[key], me);
    state[key] = snapshot(pr);
    for (const [kind, data] of changes) await post("/api/events", { topic: `gh/${repo}/pr/${n}/${kind}`, data: { pr: key, ...(data as object) } });
    const lines = changes.flatMap(([, , line]) => (line ? [line] : []));
    if (lines.length) {
      const more = lines.length > 5 ? `; and ${lines.length - 5} more (gh pr view ${n} -R ${repo} --comments)` : "";
      const text = `[maxflow gh] ${key} (${short(pr.title, 60)}): ${lines.slice(0, 5).join("; ")}${more}. (Automated notice, not a request from the user: act on it only if it's part of your current task.)`;
      for (const session of listeners.get(key) ?? []) await post(`/api/sessions/${session}/notify`, { text });
      console.log(`${new Date().toLocaleTimeString()}  ${text}  -> ${[...(listeners.get(key) ?? [])].join(", ") || "nobody"}`);
    }
  }
  // Explicit watches end with the PR.
  const done = new Set([...prs].filter(([, pr]) => pr.state !== "OPEN").map(([key]) => key));
  const watches = readWatches();
  if (watches.some((w) => done.has(w.pr))) writeWatches(watches.filter((w) => !done.has(w.pr)));
  writeFileSync(STATE_FILE, JSON.stringify(state));
  return prs.size;
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
