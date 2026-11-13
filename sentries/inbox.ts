#!/usr/bin/env bun
// inbox sentry: what reaches the user on Slack and GitHub that no session heard goes onto his board, and to an agent when one can own it.
// Plain code, no model turn of its own. From the bus it takes the Slack sentry's mentions of him, DMs to him and replies in threads he
// posted in, and the gh sentry's comments, reviews and CI failures; it polls GitHub for the PRs requesting his review or assigned to him,
// which the gh sentry then watches. Every 15 minutes it raises what has stalled as a board task, never as a ping.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INBOX_WATCH_FILE, repoOf, type Watch } from "./gh";

const STATE_DIR = join(homedir(), ".maxflow");
const STATE_FILE = join(STATE_DIR, "inbox-state.json");
const QUEUE_FILE = join(STATE_DIR, "review-queue.json");
// Regexes of check names known to be flaky: a failure of only those is re-run once per commit.
const FLAKY_FILE = join(STATE_DIR, "flaky-checks.json");
const PROJECTS = join(homedir(), ".claude", "projects");
const CLI = new URL("../cli.ts", import.meta.url).pathname;
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };
const PRS_MS = Number(process.env.INBOX_PRS_MS ?? 5 * 60_000);
const STALL_MS = Number(process.env.INBOX_STALL_MS ?? 15 * 60_000);
// A burst of Slack messages for the funnel goes as one message, this long after the first.
const BATCH_MS = Number(process.env.INBOX_BATCH_MS ?? 3 * 60_000);
const QUESTION_STALL_MS = 3 * 3_600_000;
const REVIEW_STALL_MS = 24 * 3_600_000;
const IDLE_STALL_MS = 3 * 86_400_000;
// A review agent goes only to PRs this big or touching these paths, at most MAX_AGENTS at once.
const BIG = 800;
const RISKY = /migrat|alembic|\.sql$|erp|sap|terraform|infra|helm|k8s|kubernetes|\.github\/workflows|dockerfile|auth|permission|secret/i;
const MAX_AGENTS = 2;

// A PR requesting his review or assigned to him. requested: when the latest review request was made; gone: when it left the search.
type ReviewPr = { url: string; title: string; author: string; why: "review" | "assigned"; requested: number; updated: number; gone?: number; agent?: string; risk?: string };
type Question = { key: string; at: number; who: string; text: string; link: string };
type Routed = { task: number; who: string; where: string; text: string; link: string };
type State = {
  seq: number;
  // The board task each Slack thread, DM or PR is on.
  tasks: Record<string, number>;
  prs: Record<string, ReviewPr>;
  questions: Record<string, Question>;
  // The ts of the user's last post in each thread and DM.
  answered: Record<string, number>;
  seen: string[];
  flagged: string[];
  // Each kind of bot alert about him: how often it came since its last note, and when that note was.
  alerts: Record<string, { count: number; noted: number }>;
  reruns: string[];
  batch: Routed[];
  prsAt: number;
  stallAt: number;
};
const state: State = {
  seq: 0, tasks: {}, prs: {}, questions: {}, answered: {}, seen: [], flagged: [], alerts: {}, reruns: [], batch: [], prsAt: 0, stallAt: 0,
  ...(existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}),
};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state));
const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const short = (text: string, n: number) => { const t = text.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const log = (line: string) => console.log(`${new Date().toLocaleTimeString()}  ${line}`);
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: caller, body: JSON.stringify(body) });
const run = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { stderr: "pipe" }); return r.exitCode === 0 ? r.stdout.toString().trim() : ""; };

type Task = { id: number; title: string; status: string; sessions: string[]; links: string[] };
const OPEN = (t?: Task) => !!t && t.status !== "done" && t.status !== "dropped";
const getTasks = async () => (await (await fetch(`${base}/api/tasks`)).json()) as Task[];

// Adds `event` to the open task for `key` (or one linking `link`), making one titled `title` if there is none and `title` is given.
// `status` moves it there unless an agent is already doing it.
// No session is linked: the server would move the task with that agent's waits, and a reviewer finishing doesn't mean he has.
async function onBoard(key: string, link: string, event: string, opts: { title?: string; status?: string }) {
  const tasks = await getTasks();
  const t = tasks.find((t) => t.id === state.tasks[key] && OPEN(t)) ?? tasks.findLast((t) => OPEN(t) && t.links.includes(link));
  if (!t && !opts.title) return null;
  const status = opts.status && t?.status !== "doing" && t?.status !== opts.status ? opts.status : undefined;
  const res = await post(t ? `/api/tasks/${t.id}` : "/api/tasks", {
    ...(!t && { title: opts.title }), ...(status && { status }), link,
    event: status ? `why here: ${event}` : event,
  });
  if (!res.ok) return log(`board write failed for ${key}: ${await res.text()}`), null;
  const id = ((await res.json()) as Task).id;
  state.tasks[key] = id;
  await post("/api/events", { topic: `inbox/${t ? "update" : "task"}`, data: { task: id, key, link, event } });
  log(`T-${id} ${t ? "updated" : "made"}: ${event}`);
  return id;
}
const closeTask = async (key: string, event: string) => {
  const t = (await getTasks()).find((t) => t.id === state.tasks[key]);
  if (OPEN(t)) await post(`/api/tasks/${t!.id}`, { status: "done", event: `why here: ${event}` });
};

// ---- Slack

const slackLink = (target: string) => { const [c, ts] = target.split("/"); return `https://dryftai.slack.com/archives/${c}${ts ? `/p${ts.replace(".", "")}` : ""}`; };
// A DM is one conversation, keyed by its channel; anything else by its thread.
function keyOf(d: { link: string; thread?: string }) {
  const m = d.link.match(/archives\/(\w+)\/p\d+(\?thread_ts=)?/);
  if (m?.[1].startsWith("D") && !m[2]) return m[1];
  return d.thread ?? m?.[1] ?? d.link;
}

// The chat that posted in a Slack thread, for a reply that came after its 3-day tie ran out.
function chatThatPosted(ts: string) {
  const out = run(["rg", "-l", "--max-count", "1", "--glob", "*.jsonl", `slack_send_message.*${ts.replace(".", "\\.")}`, PROJECTS]);
  const files = out.split("\n").filter(Boolean).filter((f) => !f.includes("/subagents/"));
  return files.map((f) => ({ f, at: Bun.file(f).lastModified })).sort((a, b) => b.at - a.at)[0]?.f.match(/([\w-]+)\.jsonl$/)?.[1];
}

type Session = { id: string; name: string; running: boolean; sentry: boolean; chatId?: string; transcript?: string };
const sessions = async () => (await (await fetch(`${base}/api/sessions`)).json()) as Session[];

// Hands a message to the chat that owns its thread, reviving that chat when it isn't running. Returns the session, or null.
async function toOwner(key: string, line: string) {
  const ts = key.split("/")[1];
  const chat = ts && chatThatPosted(ts);
  if (!chat) return null;
  let s = (await sessions()).find((s) => s.running && (s.chatId === chat || s.transcript?.endsWith(`${chat}.jsonl`)));
  if (!s) {
    const res = await fetch(`${base}/api/chats/${chat}/resume`, { method: "POST", body: JSON.stringify({ bypass: true }) });
    if (!res.ok) return log(`revive ${chat} failed: ${await res.text()}`), null;
    s = (await res.json()) as Session;
  }
  run([CLI, "slack", "watch", key, "--session", s.id]);
  await post(`/api/sessions/${s.id}/notify`, {
    text: `[maxflow inbox] A new message in a Slack thread you posted in, which no session was watching: ${line} Whole thread: ${CLI} slack read ${key}. It's on the user's board; act on it if it's yours to answer or fix, and never post as him without his say-so.`,
  });
  return s.id;
}

async function onSlack(topic: string, d: any, me: string) {
  if (!d?.link || state.seen.includes(d.ts)) return;
  const key = keyOf(d);
  // His own posts answer what was asked there before them, whoever typed them.
  if (topic === "slack/own" || d.user === me) {
    state.answered[key] = Math.max(state.answered[key] ?? 0, Number(d.ts));
    return;
  }
  const kind = topic === "slack/mention" ? "mention" : topic === "slack/dm" ? "dm" : /^slack\/\w+\/[\d.]+\/reply$/.test(topic) ? "reply" : null;
  if (!kind || d.told?.length || d.agent || (d.bot && kind !== "mention")) return;
  state.seen = [...state.seen, d.ts].slice(-1000);
  if (d.bot) return onBotAlert(d);
  const where = kind === "dm" ? "a DM" : String(d.where ?? "").replace(/^thread .* in /, "") || "Slack";
  const line = `${d.from} in ${where}: "${short(d.text, 200)}" ${d.link}`;
  const owner = kind === "reply" || kind === "mention" ? await toOwner(key, line) : null;
  const link = key.startsWith("http") ? key : slackLink(key);
  const task = await onBoard(key, link, `${d.from}${kind === "dm" ? " (DM)" : ""}: "${short(d.text, 120)}"${owner ? `; handed to ${owner}, the chat that posted there` : ""}`, {
    title: `Reply to ${d.from} in ${where}: "${short(d.text, 50)}"`,
    status: "you",
  });
  if (/\?/.test(d.text)) state.questions[d.ts] = { key, at: Number(d.ts) * 1000, who: d.from, text: d.text, link: d.link };
  // A mention or DM nobody owns goes to the funnel, which decides whether an agent can move it forward; thread replies stay on the board.
  if (!owner && task && kind !== "reply") state.batch.push({ task, who: d.from, where, text: short(d.text, 200), link: d.link });
}

// A bot's mention of him ("a run on main is red", a skipped deploy) is one task per kind of alert, however often it repeats: its text
// without links, mentions and numbers names the kind. A repeat adds a note at most hourly; the funnel hears of a kind once per open task.
const ALERT_NOTE_MS = 3_600_000;
async function onBotAlert(d: any) {
  const plain = short(String(d.text).replace(/<[^>]*>/g, "").replace(/\d+/g, "#"), 120);
  const tag = `bot:${d.user}:${plain}`;
  const alert = (state.alerts[tag] ??= { count: 0, noted: 0 });
  alert.count++;
  const open = OPEN((await getTasks()).find((t) => t.id === state.tasks[tag]));
  if (open && Date.now() - alert.noted < ALERT_NOTE_MS) return;
  const where = String(d.where ?? "Slack").replace(/^thread .* in /, "");
  const url = String(d.text).match(/<(https?:[^|>]+)/)?.[1];
  const event = open ? `${alert.count} more since the last note, latest ${url ?? d.link}` : `${d.from} in ${where}: "${short(String(d.text).replace(/<[^>]*>/g, ""), 120)}" ${url ?? ""}`;
  const task = await onBoard(tag, d.link, event, { title: `${d.from} alert: "${short(plain, 60)}"`, status: "you" });
  Object.assign(alert, { count: 0, noted: Date.now() });
  if (task && !open) state.batch.push({ task, who: d.from, where, text: short(String(d.text).replace(/<[^>]*>/g, ""), 200) + (url ? ` ${url}` : ""), link: d.link });
}

async function flushBatch() {
  if (!state.batch.length) return;
  const funnel = (await sessions()).find((s) => s.sentry && s.name === "sentry:funnel" && s.running);
  if (!funnel) return;
  const items = state.batch.splice(0);
  await post(`/api/sessions/${funnel.id}/notify`, {
    text: `[maxflow inbox] ${items.length} Slack message${items.length > 1 ? "s" : ""} to the user that no agent owns, each already a task on his board:\n${items.map((i) => `- T-${i.task} ${i.who} in ${i.where}: "${i.text}" ${i.link}`).join("\n")}\nRoute only those an agent can move forward on its own (look something up, fix what they report, draft a reply for him), and tell that agent its task id; leave the rest on the board. No agent replies on Slack as him without his say-so. Keep it brief.`,
  });
  log(`funnel: ${items.length} Slack messages`);
}

// ---- GitHub

const PR_QUERY = (q: string) => `query { search(query: ${JSON.stringify(q)}, type: ISSUE, first: 50) { nodes { ... on PullRequest {
  number url title updatedAt additions deletions author { login } repository { nameWithOwner }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, ASSIGNED_EVENT], last: 1) { nodes { ... on ReviewRequestedEvent { createdAt } ... on AssignedEvent { createdAt } } } } } } }`;
type SearchPr = { number: number; url: string; title: string; updatedAt: string; additions: number; deletions: number; author: { login: string } | null; repository: { nameWithOwner: string }; timelineItems: { nodes: { createdAt: string }[] } };
function searchPrs(q: string): SearchPr[] | null {
  const out = run(["gh", "api", "graphql", "-f", `query=${PR_QUERY(q)}`]);
  try { return JSON.parse(out).data.search.nodes; } catch { return null; }
}

// Why a PR is worth a review agent, or null.
function risk(key: string, pr: SearchPr) {
  if (pr.additions + pr.deletions > BIG) return `${pr.additions + pr.deletions} lines changed`;
  const [owner, name] = pr.repository.nameWithOwner.split("/");
  const out = run(["gh", "api", "graphql", "-f", `query=query { repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { files(first: 100) { nodes { path } } } } }`]);
  try {
    const hits = (JSON.parse(out).data.repository.pullRequest.files.nodes as { path: string }[]).map((f) => f.path).filter((p) => RISKY.test(p));
    return hits.length ? `touches ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ` +${hits.length - 3}` : ""}` : null;
  } catch {
    return log(`files of ${key} unreadable`), null;
  }
}

// A local clone of a repo, to make the review worktree from.
function cloneOf(repo: string) {
  const name = repo.split("/")[1];
  return [join(homedir(), name), join(homedir(), "Programs", name), join(homedir(), "app")].find((d) => existsSync(join(d, ".git")) && repoOf(d) === repo);
}

// A review agent in a detached worktree of the PR's head, with no GitHub writes, per the user's standing grant for big or risky PRs.
async function startReviewer(key: string, pr: ReviewPr) {
  const live = new Set((await sessions()).filter((s) => s.running).map((s) => s.id));
  if (Object.values(state.prs).filter((p) => p.agent && live.has(p.agent)).length >= MAX_AGENTS) return null;
  const [repo, n] = key.split("#");
  const clone = cloneOf(repo);
  if (!clone) return log(`no clone of ${repo} for a reviewer`), null;
  const dir = join(homedir(), "Worktrees", `review-${repo.split("/")[1]}-${n}`);
  if (!existsSync(dir)) {
    run(["git", "-C", clone, "fetch", "-q", "origin", `pull/${n}/head`]);
    if (!run(["git", "-C", clone, "worktree", "add", "--detach", dir, "FETCH_HEAD"]) && !existsSync(dir)) return log(`worktree for ${key} failed`), null;
  }
  const res = await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({ name: `review ${repo.split("/")[1]}#${n}`, cwd: dir, cmd: ["claude", "--permission-mode", "bypassPermissions"] }) });
  if (!res.ok) return null;
  const id = ((await res.json()) as Session).id;
  await post(`/api/sessions/${id}/notify`, {
    text: `[maxflow inbox] You are a review agent for ${pr.url} ("${pr.title}" by ${pr.author}), which requests the user's review. It was picked for a careful read because it ${pr.risk}. This folder is a detached worktree of its head. Read the diff (gh pr diff ${pr.url}) and the code around it, and look for correctness bugs and data-safety risks: migrations, ERP/SAP writes, infra, auth. Make no GitHub or Slack writes at all: no comments, reviews, approvals, reviewer requests or pushes. End your turn with your findings ranked by severity, each with file:line and a one-line fix, then a verdict (approve, approve with nits, or request changes) the user can act on, then run \`${CLI} wait done\`.`,
  });
  log(`reviewer ${id} on ${key}: ${pr.risk}`);
  return id;
}

async function refreshPrs(ghMe: string) {
  const requested = searchPrs("is:pr is:open review-requested:@me archived:false");
  const assigned = searchPrs(`is:pr is:open assignee:@me -author:@me archived:false`);
  if (!requested || !assigned) return log("PR search failed");
  const first = !state.prsAt;
  const now = new Map<string, { pr: SearchPr; why: ReviewPr["why"] }>();
  for (const pr of assigned) now.set(`${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase(), { pr, why: "assigned" });
  for (const pr of requested) now.set(`${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase(), { pr, why: "review" });
  for (const [key, { pr, why }] of now) {
    if (pr.author?.login === ghMe) continue;
    const known = state.prs[key];
    const requestedAt = Date.parse(pr.timelineItems.nodes[0]?.createdAt ?? "") || Date.now();
    state.prs[key] = { ...known, url: pr.url, title: pr.title, author: pr.author?.login ?? "?", why, requested: requestedAt, updated: Date.parse(pr.updatedAt), gone: undefined };
    if (known && !known.gone && known.requested === requestedAt) continue;
    // New, or asked again after he reviewed.
    const ask = why === "review" ? `${pr.author?.login} requested your review` : `assigned to you by ${pr.author?.login}'s PR`;
    const r = first ? null : risk(key, pr);
    if (r) state.prs[key].risk = r;
    const agent = r ? await startReviewer(key, state.prs[key]) : null;
    if (agent) state.prs[key].agent = agent;
    await onBoard(key, pr.url, `${ask}${agent ? `; review agent ${agent} reading it (${r})` : ""}`, {
      title: why === "review" ? `Review ${key.split("/")[1]}: ${short(pr.title, 60)}` : `${key.split("/")[1]} assigned to you: ${short(pr.title, 50)}`,
      status: "you",
    });
  }
  for (const [key, pr] of Object.entries(state.prs))
    if (!now.has(key) && !pr.gone) {
      pr.gone = Date.now();
      await closeTask(key, pr.why === "review" ? "it no longer requests your review (you reviewed, or the request was removed)" : "no longer assigned to you");
    }
  // Watched by the gh sentry while open and for a week after leaving the search, so later comments still land here.
  for (const [key, pr] of Object.entries(state.prs)) if (pr.gone && Date.now() - pr.gone > 7 * 86_400_000) delete state.prs[key], delete state.tasks[key];
  writeFileSync(INBOX_WATCH_FILE, JSON.stringify(Object.entries(state.prs).map(([pr, p]): Watch => ({ pr, sessions: p.agent ? [p.agent] : [] }))));
  state.prsAt = Date.now();
}

const ownPrs = () => new Set(readJson<{ pr: string }[]>(QUEUE_FILE, []).map((q) => q.pr));

// A CI failure whose every failed check is a known flaky one is re-run once per commit.
function rerunFlaky(key: string, d: any) {
  const flaky = readJson<string[]>(FLAKY_FILE, []).map((p) => new RegExp(p, "i"));
  const failed: string[] = d.failed ?? [];
  const tag = `${key}@${d.sha}`;
  if (!flaky.length || !failed.length || !failed.every((f) => flaky.some((re) => re.test(f))) || state.reruns.includes(tag)) return null;
  state.reruns = [...state.reruns, tag].slice(-500);
  const [repo, n] = key.split("#");
  const checks = JSON.parse(run(["gh", "pr", "checks", n, "-R", repo, "--json", "name,link,state"]) || "[]") as { name: string; link: string; state: string }[];
  const runs = new Set(checks.filter((c) => failed.includes(c.name)).flatMap((c) => c.link.match(/actions\/runs\/(\d+)/)?.[1] ?? []));
  for (const id of runs) run(["gh", "run", "rerun", id, "--failed", "-R", repo]);
  log(`re-ran flaky ${failed.join(", ")} on ${key} (${[...runs].join(", ") || "no runs found"})`);
  return runs.size ? `re-ran known-flaky ${failed.join(", ")} once` : null;
}

async function onGh(topic: string, d: any) {
  const m = topic.match(/^gh\/[^/]+\/[^/]+\/pr\/\d+\/(\w+)$/);
  if (!m || !d?.pr) return;
  const kind = m[1], key: string = d.pr;
  const reviewing = state.prs[key], mine = ownPrs().has(key);
  if (!reviewing && !mine) return;
  const url = reviewing?.url ?? `https://github.com/${key.replace("#", "/pull/")}`;
  if (kind === "ci" && d.state !== "SUCCESS" && mine) {
    const rerun = rerunFlaky(key, d);
    if (!d.told?.length) await onBoard(key, url, rerun ?? `CI failed: ${(d.failed ?? []).join(", ") || d.state}`, {});
    return;
  }
  if (reviewing && (kind === "merged" || kind === "closed")) return closeTask(key, `the PR was ${kind}`);
  // A person's comment or review that no session heard: on his own PRs the review sentry revives the owner, so this only notes it on
  // a task he already has; on a PR he reviews, it puts the task back on him.
  if (!["comment", "review", "thread"].includes(kind) || d.told?.length || !d.who || d.who.startsWith("the user") || d.author?.endsWith("[bot]")) return;
  const what = kind === "review" ? `${d.who} reviewed (${String(d.state).toLowerCase().replace("_", " ")})` : `${d.who} commented${d.path ? ` on ${d.path}` : ""}`;
  await onBoard(key, url, `${what}: "${short(d.body ?? "", 120)}"`, mine ? {} : { status: "you" });
}

// ---- Stalls, raised once each as a board task, never as a ping.

async function stalls() {
  const now = Date.now();
  const flag = (tag: string) => !state.flagged.includes(tag) && (state.flagged = [...state.flagged, tag].slice(-1000));
  for (const [key, pr] of Object.entries(state.prs)) {
    if (pr.gone) continue;
    if (pr.why === "review" && now - pr.requested > REVIEW_STALL_MS && flag(`${key}:wait:${pr.requested}`))
      await onBoard(key, pr.url, `${pr.author} has waited ${Math.floor((now - pr.requested) / 3_600_000)}h on your review`, { title: `Review ${key.split("/")[1]}: ${short(pr.title, 60)}`, status: "you" });
    if (now - pr.updated > IDLE_STALL_MS && flag(`${key}:idle:${pr.updated}`))
      await onBoard(key, pr.url, `no activity for ${Math.floor((now - pr.updated) / 86_400_000)} days`, { title: `Review ${key.split("/")[1]}: ${short(pr.title, 60)}` });
  }
  for (const [ts, q] of Object.entries(state.questions)) {
    if ((state.answered[q.key] ?? 0) > Number(ts) || now - q.at > 7 * 86_400_000) { delete state.questions[ts]; continue; }
    if (now - q.at > QUESTION_STALL_MS && flag(`q:${ts}`))
      await onBoard(q.key, q.link, `${q.who}'s question has gone ${Math.floor((now - q.at) / 3_600_000)}h without your answer`, { title: `Reply to ${q.who}: "${short(q.text, 50)}"`, status: "you" });
  }
  state.stallAt = now;
}

if (import.meta.main) {
  const ghMe = run(["gh", "api", "user", "-q", ".login"]);
  const profile = run(["mcp", "--json", "--timeout", "60", "call", "claude.ai/slack", "slack_read_user_profile", "{}"]);
  const me = profile.match(/User ID: (\w+)/)?.[1] ?? "";
  while (!(await fetch(`${base}/api/sessions`).then((r) => r.ok, () => false))) await Bun.sleep(2_000);
  if (!state.seq) state.seq = Number((await fetch(`${base}/api/events?topic=none&after=now`)).headers.get("x-maxflow-seq") ?? 0);
  log(`inbox sentry as ${ghMe || "?"} / ${me || "?"}`);
  let batchSince = 0;
  for (;;) {
    try {
      if (Date.now() - state.prsAt >= PRS_MS) await refreshPrs(ghMe);
      if (Date.now() - state.stallAt >= STALL_MS) await stalls();
      const events = (await (await fetch(`${base}/api/events?topic=**&after=${state.seq}&wait=60000`)).json()) as { seq: number; topic: string; data: any }[];
      for (const e of events) {
        state.seq = e.seq;
        if (e.topic.startsWith("slack/")) await onSlack(e.topic, e.data, me);
        else if (e.topic.startsWith("gh/")) await onGh(e.topic, e.data);
      }
      if (state.batch.length && !batchSince) batchSince = Date.now();
      if (batchSince && Date.now() - batchSince >= BATCH_MS) (await flushBatch(), (batchSince = 0));
      save();
    } catch (e) {
      log(`tick failed: ${e}`);
      await Bun.sleep(10_000);
    }
  }
}
