#!/usr/bin/env bun
// review sentry's feed: runs beside the review agent (sentries/review.md) in its pane. It stages every open PR of the user's into
// review-queue.json, has the gh sentry watch them all, and notifies the agent when a PR changes stage or a person's comment
// reaches no session. Exits with the agent.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { links, markRead, ownComment, REVIEW_WATCH_FILE, type Watch } from "./gh";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const EDGES_FILE = join(STATE_DIR, "review-edges.json");
const QUEUE_FILE = join(STATE_DIR, "review-queue.json");
const INTERVAL_MS = Number(process.env.REVIEW_SENTRY_INTERVAL ?? 120_000);
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;
// Sent with each call that touches a session, so the graph draws this sentry doing it.
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };
const agent = process.env.MAXFLOW_SESSION!;

type Pr = {
  number: number; url: string; title: string; body: string; isDraft: boolean; mergeable: string; reviewDecision: string | null; headRefName: string;
  createdAt: string; updatedAt: string; repository: { nameWithOwner: string }; reviewRequests: { totalCount: number }; autoMergeRequest: object | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
type Event = { seq: number; topic: string; data: { pr: string; told: string[]; id?: string; who?: string | null; author?: string; state?: string; body?: string; url?: string; path?: string } };
type Session = { id: string; name: string; running: boolean; links: string[]; sentry: boolean };

const QUERY = `query { search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) { nodes { ... on PullRequest {
  number url title body isDraft mergeable reviewDecision headRefName createdAt updatedAt repository { nameWithOwner } reviewRequests(first: 1) { totalCount }
  autoMergeRequest { enabledAt } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;

function openPrs(): Pr[] {
  const r = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${QUERY}`], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim());
  return JSON.parse(r.stdout.toString()).data.search.nodes;
}

// How far a PR is from prod, as the one thing blocking it next.
function stage(pr: Pr) {
  const ci = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflict";
  if (ci === "FAILURE" || ci === "ERROR") return "ci failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (ci && ci !== "SUCCESS") return "ci running";
  if (pr.reviewDecision === "APPROVED") return pr.autoMergeRequest ? "merging" : "approved";
  return pr.reviewRequests.totalCount ? "in review" : "needs reviewer";
}

const keyOf = (pr: Pr) => `${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase();
const label = (key: string) => key.split("/")[1];
const notify = (text: string) => fetch(`${base}/api/sessions/${agent}/notify`, { method: "POST", headers: caller, body: JSON.stringify({ text: `[maxflow review] ${text}` }) });

let stages = new Map<string, string>();
let titles = new Map<string, string>();

async function tick() {
  const prs = openPrs();
  const sessions = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running && !s.sentry);
  const names = new Map(sessions.map((s) => [s.id, s.name]));
  const ties = await links();
  const on = new Map<string, string[]>();
  const owners = new Map<string, string[]>();
  for (const pr of prs) {
    const repo = pr.repository.nameWithOwner.toLowerCase(), key = keyOf(pr);
    const owning = ties.filter((l) => l.session && l.repo === repo && (l.pr === key || l.branch === pr.headRefName)).map((l) => l.session);
    const mentioning = sessions.filter((s) => s.links.some((u) => u.toLowerCase() === pr.url.toLowerCase())).map((s) => s.id);
    owners.set(key, [...new Set(owning)].filter((id) => names.has(id)));
    on.set(key, [...new Set([...owning, ...mentioning])].filter((id) => names.has(id)));
  }
  const queue = prs.map((pr) => ({
    pr: keyOf(pr), url: pr.url, title: pr.title, stage: stage(pr), visual: /<img|!\[|user-attachments/.test(pr.body), created: pr.createdAt, updated: pr.updatedAt,
    sessions: on.get(keyOf(pr))!.map((id) => ({ id, name: names.get(id) })),
  }));
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  writeFileSync(REVIEW_WATCH_FILE, JSON.stringify(queue.map((q): Watch => ({ pr: q.pr, sessions: owners.get(q.pr)! }))));
  writeFileSync(EDGES_FILE, JSON.stringify(queue.flatMap((q) => q.sessions.map((s) => ({ session: s.id, label: label(q.pr) })))));

  const next = new Map(queue.map((q) => [q.pr, q.stage]));
  const first = !stages.size;
  const moved = [
    ...queue.filter((q) => stages.get(q.pr) !== q.stage).map((q) => `${label(q.pr)} ${stages.has(q.pr) ? `${stages.get(q.pr)} -> ` : "new, "}${q.stage}`),
    ...[...stages.keys()].filter((k) => !next.has(k)).map((k) => `${label(k)} gone (merged or closed): ${titles.get(k)}`),
  ];
  stages = next;
  titles = new Map(queue.map((q) => [q.pr, q.title]));
  if (first) await notify(`Feed up: ${queue.length} open PRs staged in ${QUEUE_FILE}. Build the queue.`);
  else if (moved.length) await notify(`Stage changes: ${moved.join("; ")}.`);
  process.title = `review feed (${queue.length} PRs)`;
}

// A person's comment or review that no session heard about falls to the agent to deliver.
function unheard(e: Event) {
  const d = e.data, kind = e.topic.split("/").at(-1)!;
  if (!["comment", "review", "thread"].includes(kind) || !d.who || d.told.length || d.author?.endsWith("[bot]") || !stages.has(d.pr)) return null;
  const what = kind === "review" ? `review (${d.state?.toLowerCase().replace("_", " ")})` : kind === "thread" ? `comment on ${d.path}` : "comment";
  return `${label(d.pr)}: ${what} from ${d.who}, heard by no session: "${(d.body ?? "").replace(/\s+/g, " ").slice(0, 500)}" ${d.url ?? ""}`;
}

if (import.meta.main) {
  let after = (await fetch(`${base}/api/events?topic=gh/**&after=now`).catch(() => null))?.headers.get("x-maxflow-seq") ?? "0";
  for (;;) {
    if (process.ppid === 1) process.exit(0);
    try {
      await tick();
    } catch (e) {
      console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
    }
    const until = Date.now() + INTERVAL_MS;
    for (let left = INTERVAL_MS; left > 0; left = until - Date.now()) {
      const events = (await fetch(`${base}/api/events?topic=gh/**&after=${after}&wait=${left}`).then((r) => r.json()).catch(() => null)) as Event[] | null;
      if (!events) await Bun.sleep(left);
      if (!events?.length) continue;
      after = String(events.at(-1)!.seq);
      for (const e of events) {
        const line = unheard(e);
        if (!line) continue;
        await notify(line);
        if (ownComment(e.data.who)) markRead(e.data.id!);
      }
    }
  }
}
