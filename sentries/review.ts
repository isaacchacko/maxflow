#!/usr/bin/env bun
// review sentry: the user's open PRs that a running session is working on and that are ready for a reviewer with none yet (CI green,
// no conflict, not approved, no review requested), each joined in the graph to those sessions. Its screen is the list. It hands them to the gh sentry
// to watch, and redraws as soon as one of them changes, with the latest changes on screen.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { links, REVIEW_WATCH_FILE, type Watch } from "./gh";

const EDGES_FILE = join(process.env.HOME!, ".maxflow", "review-edges.json");
const INTERVAL_MS = Number(process.env.REVIEW_SENTRY_INTERVAL ?? 120_000);
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

type Pr = {
  number: number; url: string; title: string; mergeable: string; reviewDecision: string | null; headRefName: string; updatedAt: string;
  repository: { nameWithOwner: string }; reviewRequests: { totalCount: number };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
type Event = { seq: number; topic: string; data: { author?: string; body?: string; state?: string; path?: string } };
type Session = { id: string; name: string; running: boolean; links: string[] };

const QUERY = `query { search(query: "is:pr is:open author:@me draft:false archived:false", type: ISSUE, first: 100) { nodes { ... on PullRequest {
  number url title mergeable reviewDecision headRefName updatedAt repository { nameWithOwner } reviewRequests(first: 1) { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;

function waiting(): Pr[] {
  const r = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${QUERY}`], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim());
  return (JSON.parse(r.stdout.toString()).data.search.nodes as Pr[]).filter((pr) =>
    pr.commits.nodes[0]?.commit.statusCheckRollup?.state === "SUCCESS" && pr.mergeable !== "CONFLICTING"
    && pr.reviewDecision !== "APPROVED" && pr.reviewDecision !== "CHANGES_REQUESTED" && pr.reviewRequests.totalCount === 0);
}

// What changed lately on the listed PRs, newest first.
const activity: string[] = [];
let listed = new Set<string>();

function record(events: Event[]) {
  for (const e of events) {
    const [, owner, repo, , n, kind] = e.topic.split("/");
    if (!listed.has(`${owner}/${repo}#${n}`.toLowerCase())) continue;
    const d = e.data, what = [kind, d.state?.toLowerCase(), d.author && `by ${d.author}`, d.path && `on ${d.path}`].filter(Boolean).join(" ");
    const body = d.body ? `: ${d.body.replace(/\s+/g, " ").slice(0, 80)}` : "";
    activity.unshift(`  ${new Date().toLocaleTimeString()}  ${`${repo}#${n}`.padEnd(16)} ${what}${body}`);
  }
  activity.splice(8);
}

async function tick() {
  const ready = waiting();
  const sessions = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running && !s.name.startsWith("sentry:"));
  const names = new Map(sessions.map((s) => [s.id, s.name]));
  const ties = await links();
  const on = new Map<string, Set<string>>();
  for (const pr of ready) {
    const repo = pr.repository.nameWithOwner.toLowerCase(), key = `${repo}#${pr.number}`;
    const ids = new Set([
      ...ties.filter((l) => l.session && l.repo === repo && (l.pr === key || l.branch === pr.headRefName)).map((l) => l.session),
      ...sessions.filter((s) => s.links.some((u) => u.toLowerCase() === pr.url.toLowerCase())).map((s) => s.id),
    ].filter((id) => names.has(id)));
    on.set(pr.url, ids);
  }
  // An open PR no session is on is old work, not something to hand a reviewer now.
  const prs = ready.filter((pr) => on.get(pr.url)!.size);
  listed = new Set(prs.map((pr) => `${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase()));
  const watches: Watch[] = prs.map((pr) => ({ pr: `${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase(), sessions: [...on.get(pr.url)!] }));
  writeFileSync(REVIEW_WATCH_FILE, JSON.stringify(watches));
  const label = (pr: Pr) => `${pr.repository.nameWithOwner.split("/")[1]}#${pr.number}`;
  writeFileSync(EDGES_FILE, JSON.stringify(prs.flatMap((pr) => [...on.get(pr.url)!].map((session) => ({ session, label: label(pr) })))));

  const row = (pr: Pr) => `  ${label(pr).padEnd(16)} ${pr.title.slice(0, 80)}\n  ${" ".repeat(16)} ${pr.url}`;
  const out = [
    `\x1b[2J\x1b[H\x1b[1mPRs to look through and get a reviewer on\x1b[0m  (${new Date().toLocaleTimeString()}, every ${INTERVAL_MS / 1000}s)`,
    `On a running session, CI green, no conflict, not approved, no review requested yet.`,
    "",
    ...(activity.length ? [`\x1b[1mLately\x1b[0m`, ...activity, ""] : []),
    ...prs.flatMap((pr) => [row(pr), `  ${" ".repeat(16)} \x1b[36m${[...on.get(pr.url)!].map((id) => names.get(id)).join(", ")}\x1b[0m`]),
  ];
  console.log(out.join("\n"));
  process.title = `review sentry (${prs.length} PRs)`;
}

if (import.meta.main) {
  let after = (await fetch(`${base}/api/events?topic=gh/**&after=now`).catch(() => null))?.headers.get("x-maxflow-seq") ?? "0";
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
    }
    // Wait out the interval on the event bus, redrawing early when a listed PR changes.
    const until = Date.now() + INTERVAL_MS;
    for (let left = INTERVAL_MS; left > 0; left = until - Date.now()) {
      const events = (await fetch(`${base}/api/events?topic=gh/**&after=${after}&wait=${left}`).then((r) => r.json()).catch(() => null)) as Event[] | null;
      if (!events) await Bun.sleep(left);
      if (!events?.length) continue;
      after = String(events.at(-1)!.seq);
      const before = activity[0];
      record(events);
      if (activity[0] !== before) break;
    }
  }
}
