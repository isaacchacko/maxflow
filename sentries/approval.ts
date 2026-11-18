#!/usr/bin/env bun
// approval sentry: each of the user's open PRs waiting on an approval gets one good review per head, and once it passes, it goes to
// Liudvikas' approval endpoint, which approves it as him (approval-notify.ts). Plain code, no model turn of its own. It reads the gh sentry's
// PRs (gh-status.json) and the review queue, scores each new head
// into a risk tier from its paths, size, complexity delta (lizard, base vs head), churn, tests and spread, and runs a headless claude
// review (sentries/approval.md) in a worktree of that head, at most MAX_REVIEWS at once. Each verdict goes to approval/<pr>/<sha>.json
// and approval-log.md. A failed review's findings reach the PR's agent only while the WRITE_SWITCH file exists; it writes nothing
// to GitHub.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { repoOf } from "./gh";
import { BASE, STATE_DIR } from "../instance";
import { enqueue, flush, config, type Note } from "./approval-notify";

const STATE_FILE = join(STATE_DIR, "approval-state.json");
const STATUS_FILE = join(STATE_DIR, "gh-status.json");
const QUEUE_FILE = join(STATE_DIR, "review-queue.json");
const OUT_DIR = join(STATE_DIR, "approval");
const LOG_FILE = join(STATE_DIR, "approval-log.md");
export const WRITE_SWITCH = join(STATE_DIR, "approval-write");
const BRIEF = new URL("./approval.md", import.meta.url).pathname;
const TICK_MS = Number(process.env.APPROVAL_TICK_MS ?? 2 * 60_000);
const MAX_REVIEWS = 2;
const DRAFT_RECHECK_MS = 30 * 60_000;
const REVIEW_TIMEOUT_MS = 40 * 60_000;
const MODEL = "claude-opus-5-5";
const MAX_ROUNDS = 3;

// The inbox sentry's risky paths, outside tests and snapshots; with the fast-lane deny list and CODEOWNERS, any hit makes a PR tier 3.
const RISKY = /migrat|alembic|\.sql$|erp|sap|terraform|infra|helm|k8s|kubernetes|\.github\/workflows|dockerfile|auth|permission|secret/i;
const CORE_FLOW = /\/(cases?|suggestions?|instructions?|integrations?|mail(box)?|email|erp|api\/routes?|routes?\/api)\b|frontend\/src\/client\//i;
const TEST = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]+\.py$|_test\.py$|\.(test|spec)\.[jt]sx?$/;
const CODE = /\.(py|ts|tsx|js|jsx)$/;
const UNCOUNTED = /__snapshots__\/|\.lock$|lock\.ya?ml$|routeTree\.gen\.ts$|\.gen\./;

type Signals = {
  base: string; files: number; lines: number; fastLane: { eligible: boolean; category: string | null; reasons: string[] } | null;
  risky: string[]; owned: string[]; complexity: string[]; churn: number; tests: boolean; spread: string[]; coreFlow: string[];
};
type Comment = { path: string; line: number; severity: "blocking" | "major" | "nit"; body: string; suggestion?: string };
type Review = { verdict: "approve" | "approve_with_nits" | "request_changes"; summary: string; ticket: string; checked: string[]; tests: string; comments: Comment[] };
type Head = {
  sha: string; url: string; title: string; author: string; status: "queued" | "reviewing" | "done" | "skipped" | "failed";
  why?: string; tier?: number; reasons?: string[]; signals?: Signals; lenses?: string[]; reviews?: (Review & { lens: string; usd: number; tokens: number })[];
  started?: number; finished?: number; handed?: number;
};
// rounds: how many heads of each PR went back to its agent with findings.
type State = { heads: Record<string, Head>; rounds: Record<string, number> };

const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const state: State = { heads: {}, rounds: {}, ...readJson<Partial<State>>(STATE_FILE, {}) };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
const log = (line: string) => console.log(`${new Date().toLocaleTimeString()}  ${line}`);
const run = (cmd: string[], cwd?: string) => { const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe" }); return r.exitCode === 0 ? r.stdout.toString().trim() : ""; };
const me = run(["gh", "api", "user", "--jq", ".login"]);

// The user's PRs waiting on an approval: open, review required, CI not failing, not a draft per the review queue.
function waiting() {
  const drafts = new Set(readJson<{ pr: string; stage: string }[]>(QUEUE_FILE, []).filter((q) => q.stage === "draft").map((q) => q.pr));
  const status = readJson<Record<string, { pr: any }>>(STATUS_FILE, {});
  return Object.entries(status).flatMap(([key, { pr }]) => {
    const ci = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
    if (pr.author?.login !== me || pr.state !== "OPEN" || pr.reviewDecision !== "REVIEW_REQUIRED" || ci === "FAILURE" || ci === "ERROR" || drafts.has(key)) return [];
    return [{ key, pr }];
  });
}

function cloneOf(repo: string) {
  const name = repo.split("/")[1];
  return [join(homedir(), name), join(homedir(), "Programs", name), join(homedir(), "app")].find((d) => existsSync(join(d, ".git")) && repoOf(d) === repo);
}

// CODEOWNERS paths with owners, last rule winning, as globs.
function ownedGlobs(clone: string, ref: string) {
  const text = run(["git", "-C", clone, "show", `${ref}:.github/CODEOWNERS`]);
  return text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => {
    const [pattern, ...owners] = l.split(/\s+/);
    let glob = pattern.startsWith("/") ? pattern.slice(1) : pattern.includes("/") ? pattern : `**/${pattern}`;
    if (glob.endsWith("/")) glob += "**";
    return { glob: new Bun.Glob(glob), owned: owners.length > 0 };
  });
}
const isOwned = (rules: ReturnType<typeof ownedGlobs>, path: string) => rules.findLast((r) => r.glob.match(path))?.owned ?? false;

// Functions at head whose cyclomatic complexity crossed 15 or rose by 5 or more since the base.
function complexity(dir: string, base: string, paths: string[]) {
  const tmp = join(OUT_DIR, "lizard", String(process.pid));
  rmSync(tmp, { recursive: true, force: true });
  for (const side of ["base", "head"] as const)
    for (const p of paths) {
      const text = run(["git", "-C", dir, "show", `${side === "base" ? base : "HEAD"}:${p}`]);
      if (!text) continue;
      mkdirSync(dirname(join(tmp, side, p)), { recursive: true });
      writeFileSync(join(tmp, side, p), text);
    }
  const ccn = (side: string) => {
    const out = existsSync(join(tmp, side)) ? run(["uvx", "lizard", "--csv", join(tmp, side)]) : "";
    // NLOC,CCN,token,PARAM,length,location,file,function,long_name,start,end
    return new Map(out.split("\n").filter(Boolean).map((row) => {
      const cols = row.match(/("[^"]*"|[^,]+)/g)!.map((c) => c.replace(/^"|"$/g, ""));
      return [`${cols[6].slice(join(tmp, side).length + 1)}:${cols[8]}`, Number(cols[1])] as const;
    }));
  };
  const before = ccn("base"), after = ccn("head");
  rmSync(tmp, { recursive: true, force: true });
  return [...after].filter(([fn, n]) => (n >= 15 && (before.get(fn) ?? 0) < 15) || n - (before.get(fn) ?? 1) >= 5)
    .map(([fn, n]) => `${fn} ${before.has(fn) ? `${before.get(fn)}→` : "new, "}${n}`);
}

// The fast lane's own classifier and policy, from the default branch, run against this head.
function fastLane(clone: string, dir: string, ref: string, base: string) {
  const lane = join(OUT_DIR, "fast-lane");
  mkdirSync(lane, { recursive: true });
  for (const f of ["classify.py", "policy.toml"]) {
    const text = run(["git", "-C", clone, "show", `${ref}:.github/fast-lane/${f}`]);
    if (!text) return null;
    writeFileSync(join(lane, f), text);
  }
  try { return JSON.parse(run(["python3", "-I", join(lane, "classify.py"), "--base", base, "--head", "HEAD"], dir)); } catch { return null; }
}

function score(clone: string, dir: string, ref: string, base: string): { signals: Signals; tier: number; reasons: string[] } {
  const changes = run(["git", "-C", dir, "diff", "--numstat", "--no-renames", base, "HEAD"]).split("\n").filter(Boolean).map((l) => {
    const [a, d, path] = l.split("\t");
    return { path, lines: (Number(a) || 0) + (Number(d) || 0) };
  });
  const counted = changes.filter((c) => !UNCOUNTED.test(c.path));
  const paths = changes.map((c) => c.path);
  const owners = ownedGlobs(clone, ref);
  const lane = fastLane(clone, dir, ref, base);
  const denied = (lane?.reasons ?? []).filter((r: string) => r.endsWith("on the deny list")).map((r: string) => r.split(":")[0]);
  const signals: Signals = {
    base, files: counted.length, lines: counted.reduce((n, c) => n + c.lines, 0), fastLane: lane && { eligible: lane.eligible, category: lane.category, reasons: lane.reasons },
    risky: [...new Set([...denied, ...paths.filter((p) => RISKY.test(p) && !TEST.test(p) && !UNCOUNTED.test(p))])],
    owned: paths.filter((p) => isOwned(owners, p)),
    complexity: complexity(dir, base, paths.filter((p) => CODE.test(p) && !TEST.test(p))),
    churn: Number(run(["git", "-C", clone, "rev-list", "--count", "--since=30.days", ref, "--", ...paths])) || 0,
    tests: paths.some((p) => TEST.test(p)),
    spread: [...new Set(paths.map((p) => p.split("/")[0]))],
    coreFlow: paths.filter((p) => CORE_FLOW.test(p)),
  };
  const s = signals;
  if (s.risky.length || s.owned.length) return { signals, tier: 3, reasons: [...s.risky.map((p) => `risky path ${p}`), ...s.owned.map((p) => `code owners own ${p}`)].slice(0, 6) };
  if (s.fastLane?.eligible) return { signals, tier: 0, reasons: [`fast lane: ${s.fastLane.category}`] };
  const reasons = [
    s.lines > 400 && `${s.lines} lines`, s.files > 15 && `${s.files} files`, s.complexity.length >= 2 && `${s.complexity.length} complexity jumps`,
    s.coreFlow.length && `core flow: ${s.coreFlow.slice(0, 2).join(", ")}`, s.spread.length >= 3 && `spans ${s.spread.join(", ")}`,
    !s.tests && s.lines > 150 && "no tests touched",
  ].filter(Boolean) as string[];
  return { signals, tier: reasons.length ? 2 : 1, reasons: reasons.length ? reasons : [`${s.lines} lines, ${s.files} files, no risk signal`] };
}

const SCHEMA = JSON.stringify({
  type: "object", additionalProperties: false, required: ["verdict", "summary", "ticket", "checked", "tests", "comments"],
  properties: {
    verdict: { enum: ["approve", "approve_with_nits", "request_changes"] }, summary: { type: "string" }, ticket: { type: "string" },
    checked: { type: "array", items: { type: "string" } }, tests: { type: "string" },
    comments: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "line", "severity", "body"], properties: {
      path: { type: "string" }, line: { type: "integer" }, severity: { enum: ["blocking", "major", "nit"] }, body: { type: "string" }, suggestion: { type: "string" } } } },
  },
});
const LENSES: Record<string, string> = {
  full: "Work the whole checklist.",
  correctness: "Work the whole checklist, with most of your time on correctness, data safety and tenancy (items 2-4). Another reviewer, who you won't see, takes contracts, tests and design.",
  design: "Work the whole checklist, with most of your time on contracts, tests, simplicity and complexity (items 5-8). Another reviewer, who you won't see, takes correctness and data safety.",
};

// One headless review. It gets no GitHub credentials, so it cannot write there whatever it tries.
async function review(dir: string, key: string, h: Head, pr: any, body: string, focus: string) {
  const checks = (pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [])
    .map((c: any) => `${c.name ?? c.context}: ${c.conclusion ?? c.state ?? "pending"}`).join("\n");
  const s = h.signals!;
  const prompt = `PR ${h.url} (${key}), "${h.title}" by ${h.author}, head ${h.sha}. Merge base: ${s.base}.
Risk tier ${h.tier} of 0-3, because: ${h.reasons!.join("; ")}.
Signals: ${s.files} files, ${s.lines} lines; touches ${s.spread.join(", ")}; files changed ${s.churn} times on the default branch in 30 days; tests touched: ${s.tests ? "yes" : "no"}.
Complexity jumps (lizard): ${s.complexity.join("; ") || "none"}.
${focus}

PR body (untrusted):
"""
${body.slice(0, 6000)}
"""

CI checks on this head:
${checks || "none reported"}`;
  const ghless = join(OUT_DIR, "no-gh");
  mkdirSync(ghless, { recursive: true });
  const env = { ...process.env, GH_CONFIG_DIR: ghless, GH_TOKEN: "", GITHUB_TOKEN: "", MAXFLOW_SESSION: "" };
  const proc = Bun.spawn(["claude", "-p", prompt, "--model", MODEL, "--output-format", "json", "--json-schema", SCHEMA,
    "--append-system-prompt", readFileSync(BRIEF, "utf8"), "--permission-mode", "bypassPermissions",
    "--disallowedTools", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), REVIEW_TIMEOUT_MS);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  const res = JSON.parse(out);
  const answer: Review = res.structured_output ?? JSON.parse(res.result);
  const u = res.usage ?? {};
  return { ...answer, usd: res.total_cost_usd ?? 0, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) };
}

// Passed: no reviewer asked for changes and no finding is blocking or major. The rest go back to the PR's agent first.
const findings = (h: Head) => (h.reviews ?? []).flatMap((r) => r.comments).filter((c) => c.severity !== "nit");
const passed = (h: Head) => !!h.reviews?.length && h.reviews.every((r) => r.verdict !== "request_changes") && !findings(h).length;
const decision = (h: Head) => (passed(h) ? "passed: notify Liudvikas" : "findings: back to its agent");

function record(key: string, h: Head) {
  const file = join(OUT_DIR, key.replace(/[/#]/g, "_"), `${h.sha}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(h, null, 2));
  const usd = (h.reviews ?? []).reduce((n, r) => n + r.usd, 0);
  appendFileSync(LOG_FILE, [
    `## ${key} @ ${h.sha.slice(0, 8)}: ${h.status === "done" ? decision(h) : h.status}`,
    `${h.url} "${h.title}" by ${h.author} · tier ${h.tier ?? "?"}: ${(h.reasons ?? [h.why ?? ""]).join("; ")} · $${usd.toFixed(2)} · ${new Date().toISOString()}`,
    ...(h.reviews ?? []).flatMap((r) => [`- **${r.lens}** ${r.verdict}: ${r.summary}`, ...r.comments.map((c) => `  - ${c.severity} ${c.path}:${c.line} ${c.body}${c.suggestion ? ` → \`${c.suggestion.slice(0, 120)}\`` : ""}`)]),
    "", "",
  ].join("\n"));
}

// The blocking and major findings go to the PR's maxflow session to fix and push, and the new head is reviewed again. A PR with no
// session goes to the review sentry, which revives the chat that opened it or starts one. After MAX_ROUNDS heads it stops asking.
async function handBack(key: string, h: Head) {
  const rounds = (state.rounds[key] ?? 0) + 1;
  state.rounds[key] = rounds;
  h.handed = Date.now();
  if (rounds > MAX_ROUNDS) return log(`${key}: findings again after ${MAX_ROUNDS} rounds; left for a human`);
  const list = findings(h).map((c) => `- ${c.severity} ${c.path}:${c.line} ${c.body}${c.suggestion ? `\n  suggestion: ${c.suggestion}` : ""}`).join("\n");
  const ask = `The approval sentry's review of ${h.url} at ${h.sha.slice(0, 8)} (tier ${h.tier}, round ${rounds} of ${MAX_ROUNDS}) found these. Liudvikas is asked to approve it only once a head passes. Fix the real ones and push; the new head is reviewed again on its own. If one is wrong, leave it and say why in your commit message.\n${list}`;
  const sessions = readJson<{ pr: string; sessions: { id: string }[] }[]>(QUEUE_FILE, []).find((q) => q.pr === key)?.sessions ?? [];
  const all = (await fetch(`${BASE}/api/sessions`).then((r) => r.json()).catch(() => [])) as { id: string; name: string }[];
  const reviewSentry = all.find((s) => s.name === "sentry:review")?.id;
  const to = sessions[0]?.id ?? reviewSentry;
  const text = sessions[0] ? `[maxflow approval] ${ask}` : `[maxflow approval] ${h.url} has no session. Get these findings to its chat as in your job 1 (revive the chat that opened it, or start one on its branch), verbatim, and tell it to fix and push:\n\n${ask}`;
  if (to) await fetch(`${BASE}/api/sessions/${to}/notify`, { method: "POST", body: JSON.stringify({ text }) }).catch(() => null);
  log(`${key}: findings (round ${rounds}) to ${sessions[0] ? sessions[0].id : `the review sentry ${to ?? "(not found)"}`}`);
}

async function work(key: string, h: Head, pr: any) {
  const [repo, n] = key.split("#");
  const clone = cloneOf(repo);
  if (!clone) return Object.assign(h, { status: "skipped", why: `no clone of ${repo}` });
  const meta = JSON.parse(run(["gh", "pr", "view", n, "-R", repo, "--json", "isDraft,baseRefName,body"]) || "null");
  if (!meta) return Object.assign(h, { status: "failed", why: "gh pr view failed" });
  if (meta.isDraft) return Object.assign(h, { status: "skipped", why: "draft", finished: Date.now() });
  const ref = `origin/${meta.baseRefName}`;
  run(["git", "-C", clone, "fetch", "-q", "origin", meta.baseRefName, `pull/${n}/head`]);
  const dir = join(homedir(), "Worktrees", `approval-${repo.split("/")[1]}-${n}`);
  if (existsSync(dir)) run(["git", "-C", dir, "checkout", "-q", "--detach", h.sha]);
  else run(["git", "-C", clone, "worktree", "add", "-q", "--detach", dir, h.sha]);
  if (run(["git", "-C", dir, "rev-parse", "HEAD"]) !== h.sha) return Object.assign(h, { status: "failed", why: "worktree not at head" });
  try {
    const base = run(["git", "-C", dir, "merge-base", ref, "HEAD"]);
    Object.assign(h, score(clone, dir, ref, base));
    h.lenses = h.tier! >= 2 ? ["correctness", "design"] : ["full"];
    log(`${key}@${h.sha.slice(0, 8)}: tier ${h.tier} (${h.reasons!.join("; ")}), ${h.lenses.length} review(s)`);
    save();
    h.reviews = [];
    // A second reviewer starts only after the first, so MAX_REVIEWS holds across PRs.
    for (const lens of h.lenses) h.reviews.push(await review(dir, key, h, pr, meta.body ?? "", LENSES[lens]).then((r) => ({ ...r, lens })));
    Object.assign(h, { status: "done", finished: Date.now() });
  } catch (e) {
    Object.assign(h, { status: "failed", why: String(e).slice(0, 300), finished: Date.now() });
  } finally {
    run(["git", "-C", clone, "worktree", "remove", "--force", dir]);
  }
  log(`${key}@${h.sha.slice(0, 8)}: ${h.status} ${h.status === "done" ? decision(h) : h.why ?? ""}`);
  return h;
}

const active = new Set<string>();
function tick() {
  for (const { key, pr } of waiting()) {
    const h = state.heads[key];
    if (active.has(key)) continue;
    const recheck = h?.status === "skipped" && h.why === "draft" && Date.now() - (h.finished ?? 0) > DRAFT_RECHECK_MS;
    if (h?.sha === pr.headRefOid && !recheck && h.status !== "reviewing") continue;
    state.heads[key] = { sha: pr.headRefOid, url: pr.url, title: pr.title, author: pr.author?.login ?? "?", status: "queued", started: Date.now() };
  }
  const queued = Object.entries(state.heads).filter(([k, h]) => h.status === "queued" && !active.has(k)).sort(([, a], [, b]) => a.started! - b.started!);
  const status = readJson<Record<string, { pr: any }>>(STATUS_FILE, {});
  for (const [key, h] of queued) {
    if (active.size >= MAX_REVIEWS) break;
    active.add(key);
    h.status = "reviewing";
    work(key, h, status[key]?.pr ?? {}).then((done) => { if (done.status !== "skipped" || done.why !== "draft") record(key, done); }).finally(() => { active.delete(key); save(); });
  }
  save();
  const live = new Map(waiting().map(({ key, pr }) => [key, pr.headRefOid]));
  for (const [key, h] of Object.entries(state.heads)) {
    if (h.status !== "done" || live.get(key) !== h.sha) continue;
    if (passed(h)) enqueue(note(key, h));
    else if (!h.handed && existsSync(WRITE_SWITCH)) handBack(key, h).then(save);
  }
  flush((n) => live.get(n.pr) === n.sha);
}

const note = (key: string, h: Head): Note => ({
  pr: key, sha: h.sha, title: h.title, url: h.url, tier: h.tier!,
  summary: h.reviews!.map((r) => r.summary).join(" ").slice(0, 600),
});

mkdirSync(OUT_DIR, { recursive: true });
log(`approval sentry up as ${me || "?"}; ${existsSync(WRITE_SWITCH) ? "handing findings to the PRs' agents" : `shadow mode (touch ${WRITE_SWITCH} to act)`}; notifier ${config().url ? "sending" : "shadow (no url)"}`);
tick();
setInterval(tick, TICK_MS);
