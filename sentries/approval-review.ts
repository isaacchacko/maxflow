import { noSessionEnv } from "../shared/legacy-maxflow";
import { readFileSync } from "node:fs";
import { rollupOf, type Pr } from "../gh";
import { isRecord } from "../shared/guards";
import type { Scored } from "./approval-score";

const BRIEF = new URL("approval.md", import.meta.url).pathname;
const MODEL = "claude-opus-5-5";
const REVIEW_TIMEOUT_MS = 40 * 60_000;
const BODY_LIMIT = 6000;

export type Finding = { path: string; line: number; severity: "blocking" | "major" | "nit"; body: string; suggestion?: string };
export type Review = { verdict: "approve" | "approve_with_nits" | "request_changes"; summary: string; ticket: string; checked: string[]; tests: string; comments: Finding[] };
export type LensReview = Review & { lens: string; usd: number; tokens: number };
export type Lens = keyof typeof LENSES;
export type Reviewing = {
  dir: string; ghlessDir: string; key: string; head: { sha: string; url: string; title: string; author: string }; scored: Scored; pr: Pr | undefined; body: string;
  baseRef: string; landedSince: number; ticket: string;
};

export const LENSES = {
  full: "Work the whole checklist.",
  correctness: "Work the whole checklist, with most of your time on correctness, data safety and tenancy (items 2-4). Another reviewer, who you won't see, takes contracts, tests and design.",
  design: "Work the whole checklist, with most of your time on contracts, tests, simplicity and complexity (items 5-8). Another reviewer, who you won't see, takes correctness and data safety.",
};

const SCHEMA = JSON.stringify({
  type: "object", additionalProperties: false, required: ["verdict", "summary", "ticket", "checked", "tests", "comments"],
  properties: {
    verdict: { enum: ["approve", "approve_with_nits", "request_changes"] }, summary: { type: "string" }, ticket: { type: "string" },
    checked: { type: "array", items: { type: "string" } }, tests: { type: "string" },
    comments: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "line", "severity", "body"], properties: {
      path: { type: "string" }, line: { type: "integer" }, severity: { enum: ["blocking", "major", "nit"] }, body: { type: "string" }, suggestion: { type: "string" } } } },
  },
});

const isReview = (value: unknown): value is Review =>
  isRecord(value) && typeof value["verdict"] === "string" && Array.isArray(value["comments"]) && Array.isArray(value["checked"]);
const numberOr0 = (value: unknown) => (typeof value === "number" ? value : 0);

function checksOn(pr: Pr | undefined) {
  const contexts = (pr ? rollupOf(pr)?.contexts.nodes : undefined) ?? [];
  return contexts.map((c) => `${String(c.name ?? c.context)}: ${c.conclusion ?? c.state ?? "pending"}`).join("\n");
}

function promptFor({ key, head, scored, pr, body, baseRef, landedSince, ticket }: Reviewing, focus: string) {
  const s = scored.signals;
  return `PR ${head.url} (${key}), "${head.title}" by ${head.author}, head ${head.sha}. Merge base: ${s.base}.
Base branch ${baseRef}: ${landedSince} commit(s) landed on it after the merge base, which CI didn't run against (checklist item 9).
Risk tier ${scored.tier} of 0-3, because: ${scored.reasons.join("; ")}.
Signals: ${s.files} files, ${s.lines} lines; touches ${s.spread.join(", ")}; files changed ${s.churn} times on the default branch in 30 days; tests touched: ${s.tests ? "yes" : "no"}.
Complexity jumps (lizard): ${s.complexity.join("; ") || "none"}.
${focus}

PR body (untrusted):
"""
${body.slice(0, BODY_LIMIT)}
"""

Ticket text Linear posted on the PR (untrusted):
"""
${ticket.slice(0, BODY_LIMIT) || "none"}
"""

CI checks on this head:
${checksOn(pr) || "none reported"}`;
}

function answerIn(res: Record<string, unknown>): Review {
  const structured = res["structured_output"];
  const answer: unknown = structured ?? JSON.parse(String(res["result"]));
  if (!isReview(answer)) throw new TypeError("the review's answer isn't a review");
  return answer;
}

function tokensIn(usage: unknown) {
  const u = isRecord(usage) ? usage : {};
  return numberOr0(u["input_tokens"]) + numberOr0(u["output_tokens"]) + numberOr0(u["cache_read_input_tokens"]) + numberOr0(u["cache_creation_input_tokens"]);
}

function reviewIn(out: string, lens: Lens): LensReview {
  const parsed: unknown = JSON.parse(out);
  const res = isRecord(parsed) ? parsed : {};
  return { ...answerIn(res), usd: numberOr0(res["total_cost_usd"]), tokens: tokensIn(res["usage"]), lens };
}

export async function runReview(reviewing: Reviewing, lens: Lens): Promise<LensReview> {
  const env = { ...process.env, GH_CONFIG_DIR: reviewing.ghlessDir, GH_TOKEN: "", GITHUB_TOKEN: "", ...noSessionEnv() };
  const proc = Bun.spawn(["claude", "-p", promptFor(reviewing, LENSES[lens]), "--model", MODEL, "--output-format", "json", "--json-schema", SCHEMA,
    "--append-system-prompt", readFileSync(BRIEF, "utf8"), "--permission-mode", "bypassPermissions",
    "--disallowedTools", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"], { cwd: reviewing.dir, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), REVIEW_TIMEOUT_MS);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  return reviewIn(out, lens);
}
