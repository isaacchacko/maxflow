#!/usr/bin/env bun
// review sentry: the user's open PRs that are ready for a reviewer and have none yet (CI green, no conflict, not approved,
// no review requested), each joined in the graph to the sessions working on it. Its screen is the list.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { links } from "./gh";

const EDGES_FILE = join(process.env.HOME!, ".maxflow", "review-edges.json");
const INTERVAL_MS = Number(process.env.REVIEW_SENTRY_INTERVAL ?? 120_000);
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

type Pr = {
  number: number; url: string; title: string; mergeable: string; reviewDecision: string | null; headRefName: string; updatedAt: string;
  repository: { nameWithOwner: string }; reviewRequests: { totalCount: number };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
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

async function tick() {
  const prs = waiting();
  const sessions = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running && !s.name.startsWith("sentry:"));
  const names = new Map(sessions.map((s) => [s.id, s.name]));
  const ties = await links();
  const on = new Map<string, Set<string>>();
  for (const pr of prs) {
    const repo = pr.repository.nameWithOwner.toLowerCase(), key = `${repo}#${pr.number}`;
    const ids = new Set([
      ...ties.filter((l) => l.session && l.repo === repo && (l.pr === key || l.branch === pr.headRefName)).map((l) => l.session),
      ...sessions.filter((s) => s.links.some((u) => u.toLowerCase() === pr.url.toLowerCase())).map((s) => s.id),
    ].filter((id) => names.has(id)));
    on.set(pr.url, ids);
  }
  const label = (pr: Pr) => `${pr.repository.nameWithOwner.split("/")[1]}#${pr.number}`;
  writeFileSync(EDGES_FILE, JSON.stringify(prs.flatMap((pr) => [...on.get(pr.url)!].map((session) => ({ session, label: label(pr) })))));

  const tied = prs.filter((pr) => on.get(pr.url)!.size), untied = prs.filter((pr) => !on.get(pr.url)!.size);
  const row = (pr: Pr) => `  ${label(pr).padEnd(16)} ${pr.title.slice(0, 80)}\n  ${" ".repeat(16)} ${pr.url}`;
  const out = [
    `\x1b[2J\x1b[H\x1b[1mPRs to look through and get a reviewer on\x1b[0m  (${new Date().toLocaleTimeString()}, every ${INTERVAL_MS / 1000}s)`,
    `CI green, no conflict, not approved, no review requested yet.`,
    "",
    `\x1b[1mNo session (${untied.length})\x1b[0m`,
    ...untied.map(row),
    "",
    // Last, so a short pane still shows the ones with an edge.
    `\x1b[1mOn a session (${tied.length})\x1b[0m`,
    ...tied.flatMap((pr) => [row(pr), `  ${" ".repeat(16)} \x1b[36m${[...on.get(pr.url)!].map((id) => names.get(id)).join(", ")}\x1b[0m`]),
  ];
  console.log(out.join("\n"));
  process.title = `review sentry (${prs.length} PRs)`;
}

if (import.meta.main)
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
    }
    await Bun.sleep(INTERVAL_MS);
  }
