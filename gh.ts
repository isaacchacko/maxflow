import { BASE, TMUX_SOCKET } from "./instance";
import { ghStatusTable } from "./state";

export type Watch = { pr: string; sessions: string[] };
export type Link = { pr?: string; repo: string; branch?: string; session: string };

type Author = { login: string } | null;
type CheckContext = { __typename: string; name?: string; conclusion?: string; context?: string; state?: string };
type Review = { id: string; state: string; body: string; author: Author };
type Comment = { id: string; body: string; url: string; author: Author };
export type ThreadComment = Comment & { path: string };
export type Pr = {
  number: number; url: string; title: string; state: string; createdAt: string; updatedAt?: string; mergeable: string; reviewDecision: string | null; headRefOid: string; headRefName: string;
  author: { __typename: string; login: string } | null; authorAssociation: string;
  commits: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: CheckContext[] } } | null } }[] };
  reviews: { nodes: Review[] };
  comments: { nodes: Comment[] };
  reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: ThreadComment[] } }[] };
};
export type Head = {
  number: number; updatedAt: string; state: string; mergeable: string; reviewDecision: string | null; headRefOid: string;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
export type PolledPr = { at: number; pr: Pr };
type Found<T> = { byNumber: Map<number, T>; byBranch: Map<string, T> };
export type Session = {
  id: string; name: string; cwd: string; running: boolean; sentry: boolean; chatId?: string; transcript?: string;
  links: string[]; pending: number; status: string; blocked: object | null;
};

const SESSIONS_TIMEOUT_MS = 30_000;
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);
const PENDING_CHECKS = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS"]);
const REPO_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/;
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const PR_KEY = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const PR_NUMBER = /^#?(\d+)$/;
const PRS_PER_FULL_QUERY = 20;
const PRS_PER_HEAD_QUERY = 100;

const FIELDS = `number url title state createdAt updatedAt mergeable reviewDecision headRefOid headRefName author { __typename login } authorAssociation
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } }
  reviews(last: 30) { nodes { id state body author { login } } }
  comments(last: 30) { nodes { id body url author { login } } }
  reviewThreads(last: 50) { nodes { isResolved comments(last: 10) { nodes { id body path url author { login } } } } }`;
const HEAD = `number updatedAt state mergeable reviewDecision headRefOid commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

export const rateLimit = { wasHit: false };

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isPr = (value: unknown): value is Pr => isRecord(value) && typeof value["number"] === "number";
const isHead = (value: unknown): value is Head => isRecord(value) && typeof value["number"] === "number";
const isSession = (value: unknown): value is Session => isRecord(value) && typeof value["id"] === "string";

export const isFailed = (state: string) => FAILED.has(state);
export const isFinished = (state: string) => state === "SUCCESS" || isFailed(state);
export const short = (text: string, n = 300) => (text.replaceAll(/\s+/g, " ").trim().slice(0, n) + (text.length > n ? "…" : "")).trim();
export const prNumber = (key: string) => key.split("#", 2)[1] ?? "";
export const repoOfKey = (key: string) => key.split("#", 1)[0] ?? "";
export const rollupOf = (pr: Pr) => pr.commits.nodes[0]?.commit.statusCheckRollup;
export const ciStateOf = (pr: Head | Pr) => pr.commits.nodes[0]?.commit.statusCheckRollup?.state;

export function run(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

export function repoOf(cwd: string) {
  return REPO_REMOTE.exec(run(["git", "-C", cwd, "remote", "get-url", "origin"]))?.[1]?.toLowerCase() ?? "";
}

function prKeyOf(match: RegExpExecArray | null) {
  const [, repo, number] = match ?? [];
  return repo === undefined || number === undefined ? null : `${repo.toLowerCase()}#${number}`;
}

export function parsePr(ref: string, cwd: string) {
  const explicit = prKeyOf(PR_URL.exec(ref)) ?? prKeyOf(PR_KEY.exec(ref));
  if (explicit !== null) return explicit;
  const bare = PR_NUMBER.exec(ref)?.[1];
  if (bare === undefined) return null;
  const repo = repoOf(cwd);
  return repo === "" ? null : `${repo}#${bare}`;
}

function repositoryIn(stdout: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const data = isRecord(parsed) ? parsed["data"] : undefined;
    const repository = isRecord(data) ? data["r"] : undefined;
    return isRecord(repository) ? repository : {};
  } catch {
    return {};
  }
}

function graphql(repo: string, q: string, what: string) {
  const res = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${q}`], { stderr: "pipe" });
  const err = res.stderr.toString().trim();
  if (res.exitCode !== 0) console.error(`${new Date().toLocaleTimeString()}  ${repo}: graphql failed for ${what}: ${err.slice(0, 300)}`);
  if (/rate limit/i.test(err)) rateLimit.wasHit = true;
  // constraint: one PR number that doesn't resolve makes gh exit 1, but the rest of the data still comes back
  return repositoryIn(res.stdout.toString());
}

function firstNode(value: unknown): unknown {
  const nodes: unknown = isRecord(value) ? value["nodes"] : [];
  const list: unknown[] = Array.isArray(nodes) ? nodes : [];
  return list[0];
}

type Wanted = { repo: string; numbers: number[]; branches: string[] };

function query<T>({ repo, numbers, branches }: Wanted, fragment: string, chunk: number, isWanted: (value: unknown) => value is T): Found<T> {
  const [owner, name] = repo.split("/", 2);
  const parts = [
    ...numbers.map((n) => `n${n}: pullRequest(number: ${n}) { ...F }`),
    ...branches.map((b, i) => `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...F } }`),
  ];
  const r: Record<string, unknown> = {};
  for (let i = 0; i < parts.length; i += chunk) {
    const q = `query { r: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${parts.slice(i, i + chunk).join("\n")} } }\nfragment F on PullRequest { ${fragment} }`;
    Object.assign(r, graphql(repo, q, parts.length > chunk ? `chunk ${i / chunk + 1}` : "its PRs"));
  }
  return {
    byNumber: new Map(numbers.flatMap((n): [number, T][] => {
      const pr = r[`n${n}`];
      return isWanted(pr) ? [[n, pr]] : [];
    })),
    byBranch: new Map(branches.flatMap((b, i): [string, T][] => {
      const pr = firstNode(r[`b${i}`]);
      return isWanted(pr) ? [[b, pr]] : [];
    })),
  };
}

// constraint: one GraphQL query for ~80 whole PRs runs into GitHub's 10s timeout and comes back empty
export const fetchPrs = (repo: string, numbers: number[], branches: string[]) => query({ repo, numbers, branches }, FIELDS, PRS_PER_FULL_QUERY, isPr);
export const fetchHeads = (repo: string, numbers: number[], branches: string[]) => query({ repo, numbers, branches }, HEAD, PRS_PER_HEAD_QUERY, isHead);

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch(`${BASE}/api/sessions`, { signal: AbortSignal.timeout(SESSIONS_TIMEOUT_MS) });
  const sessions: unknown = await res.json();
  return Array.isArray(sessions) ? sessions.filter(isSession) : [];
}

function sessionBranchLink(s: Session): Link | undefined {
  const cwd = run(["tmux", "-L", TMUX_SOCKET, "display-message", "-p", "-t", `mf-${s.id}`, "#{pane_current_path}"]) || s.cwd;
  const repo = repoOf(cwd);
  const branch = repo === "" ? "" : run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "" || ["HEAD", "main", "master"].includes(branch) ? undefined : { repo, branch, session: s.id };
}

export function watchLinks(watches: Watch[]): Link[] {
  return watches.flatMap((w) => (w.sessions.length > 0 ? w.sessions : [""]).map((session) => ({ pr: w.pr, repo: repoOfKey(w.pr), session })));
}

export async function sessionLinks(): Promise<Link[]> {
  const live = (await fetchSessions()).filter((s) => s.running && !s.sentry);
  return live.flatMap((s) => sessionBranchLink(s) ?? []);
}

export const isOwnComment = (who: string | null | undefined) => who?.startsWith("the user") ?? false;

export async function markRead(id: string) {
  const p = Bun.spawn(["gh", "api", "graphql", "-f", `query=mutation { addReaction(input: { subjectId: ${JSON.stringify(id)}, content: EYES }) { clientMutationId } }`], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) console.error(`${new Date().toLocaleTimeString()}  👀 on ${id} failed: ${(await new Response(p.stderr).text()).trim().slice(0, 300)}`);
}

export const readStatus = (): Record<string, PolledPr> => ghStatusTable.all();

const checksOf = (pr: Pr) => rollupOf(pr)?.contexts.nodes.map((c) => ({ name: c.name ?? c.context ?? "", result: c.conclusion ?? c.state ?? "PENDING" })) ?? [];
const latestReviews = (pr: Pr) =>
  new Map(pr.reviews.nodes.filter((r) => r.state !== "COMMENTED" && r.state !== "PENDING").map((r) => [r.author?.login ?? "?", r.state.toLowerCase().replace("_", " ")]));
const unresolvedLastComments = (pr: Pr) => pr.reviewThreads.nodes.filter((t) => !t.isResolved).flatMap((t) => t.comments.nodes.at(-1) ?? []);
const listed = (label: string, names: string[]) => (names.length > 0 ? [`  ${label}: ${names.join(", ")}`] : []);
const login = (author: Author) => String(author?.login);

function latestCommentLines(pr: Pr) {
  const latest = pr.comments.nodes.slice(-3).map((c) => `  ${login(c.author)}: "${short(c.body, 200)}" ${c.url}`);
  return latest.length === 0 ? [] : ["latest comments:", ...latest];
}

export function render(key: string, pr: Pr, at: number) {
  const rollup = rollupOf(pr);
  const checks = checksOf(pr);
  const failed = checks.filter((c) => isFailed(c.result)).map((c) => c.name);
  const pending = checks.filter((c) => c.result === "" || PENDING_CHECKS.has(c.result)).map((c) => c.name);
  const reviews = [...latestReviews(pr)].map(([who, state]) => `${who} ${state}`).join("; ");
  const open = unresolvedLastComments(pr);
  const decision = (pr.reviewDecision ?? "no review decision").toLowerCase().replaceAll("_", " ");
  return [
    `${key}  ${pr.state.toLowerCase()} · ${pr.mergeable.toLowerCase()} · ${decision}  (polled ${Math.round((Date.now() - at) / 1000)}s ago)`,
    `${pr.title}  ${pr.url}`,
    `CI ${rollup?.state ?? "none"} on ${pr.headRefOid.slice(0, 7)}: ${checks.length - failed.length - pending.length} passed, ${failed.length} failed, ${pending.length} pending`,
    ...listed("failed", failed),
    ...listed("pending", pending),
    `reviews: ${reviews || "none"}`,
    `unresolved threads: ${open.length}`,
    ...open.map((c) => `  ${c.path}  ${login(c.author)}: "${short(c.body, 200)}" ${c.url}`),
    ...latestCommentLines(pr),
  ].join("\n");
}
