import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../gh";
import { STATE_DIR } from "../instance";

export const COMMENT_SWITCH = join(STATE_DIR, "approval-comment");
const OUT_DIR = join(STATE_DIR, "approval");
const MODEL = "claude-sonnet-5-5";
const WRITE_TIMEOUT_MS = 5 * 60_000;

type Finding = { path: string; line: number; severity: string; body: string };
type Reviewed = { sha: string; status: string; finished?: number; reviews?: { verdict: string; summary: string; checked: string[]; tests: string; comments: Finding[] }[] };
export type Posted = { id: number; sha: string; body: string };

const BANNED_OUTSIDE_CODE_SPANS = [
  /liud/i, /vikas/i, /approv\w* (arrangement|endpoint|request)/i, /\bas (him|isaac)\b/i, /\bisaac\b/i, /\bthe user\b/i,
  /sentr(y|ies)/i, /\bbots?\b/i, /\bagents?\b/i, /\bAI\b/, /\bLLM/i, /claude|anthropic|openai|gpt/i, /\bmodel (wrote|review|found)/i,
  /automat(ed|ic) review/i, /review (pipeline|queue|tier|round)/i, /pipeline/i, /\btiers?\b/i, /\brounds?\b/i, /headless/i,
  /shadow mode/i, /lizard/i, /risk (tier|score)/i, /\blens(es)?\b/i, /\byarn\b/i, /maxflow/i, /\bhanded? back\b/i,
];
const BANNED_ANYWHERE = [
  /maxflow/i, /\byarn\b/i, /liud/i, /sentr(y|ies)/i, /~\//, /\/Users\//, /\/home\//, /Worktrees/i, /\.maxflow/i, /STATE_DIR/,
  /\bth-[0-9a-f]{6}\b/, /\bm-[0-9a-f]{6}\b/, /\bmf-[0-9a-f]{8}\b/, /\bt\d{2,}\b/, /approval-(log|state|notify)/,
];

const withoutCodeSpans = (line: string) => line.replaceAll(/`[^`]*`/g, "");
const isBanned = (line: string) => BANNED_OUTSIDE_CODE_SPANS.some((re) => re.test(withoutCodeSpans(line))) || BANNED_ANYWHERE.some((re) => re.test(line));
const isShaLike = (token: string) => /\d/.test(token) && /[a-f]/i.test(token);
const shaLikeTokens = (line: string) => (line.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).filter((t) => isShaLike(t));
const EMPTY_BOLD_LABEL = /^\*\*[^*\n]+:\*\*\s*(?=\n\s*\*\*|$(?![\s\S]))/gm;

export function clean(text: string, shas: string[]) {
  const isHeadSha = (token: string) => shas.some((s) => s.startsWith(token.toLowerCase()));
  const kept = text.split("\n").filter((line) => !isBanned(line) && shaLikeTokens(line).every((t) => isHeadSha(t)));
  const body = kept.join("\n").replaceAll(/\n{3,}/g, "\n\n").trim().replaceAll(EMPTY_BOLD_LABEL, "").trim();
  return /checked/i.test(body) ? body : null;
}

type ReviewedHead = Reviewed & { reviews: NonNullable<Reviewed["reviews"]> };

const isReviewedHead = (h: unknown): h is ReviewedHead => isRecord(h) && h["status"] === "done" && Array.isArray(h["reviews"]) && h["reviews"].length > 0;

function readHead(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function history(key: string): ReviewedHead[] {
  const dir = join(OUT_DIR, key.replaceAll(/[/#]/g, "_"));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readHead(join(dir, f)))
    .filter(isReviewedHead)
    .toSorted((a, b) => (a.finished ?? 0) - (b.finished ?? 0));
}

const BRIEF = `You write the short review note a senior engineer leaves on a teammate's pull request after reviewing it. You get the
structured notes from the review of the latest commit, and from reviews of earlier commits whose problems later commits fixed.

Write GitHub markdown, at most about 120 words, in two parts:
**Checked:** one or two sentences, or up to four short bullets, naming the concrete things verified on this PR (e.g. "the migration
is reversible", "every caller of fetch_orders still passes a tenant", "the new endpoint has tests"). Concrete nouns from the diff, not
checklist headings.
**Caught and fixed:** only if earlier problems are listed: one bullet each, the problem in a few plain words and the commit that fixed
it in backticks, e.g. "- the backfill deleted rows without a tenant filter (\`abc1234\`)". Omit this part entirely when there are none.

Rules: plain declarative sentences, no praise, no hedging, no sign-off, no headings beyond those two bold labels, no emoji. Speak as
the reviewer in first person only if you must; prefer no pronoun. Never mention how the review was done, who or what reviewed it, who
approves it, scores, tiers, rounds, tools, bots, AI or automation, internal systems, file paths outside the repo, or ids other than the
commit shas given. Optional nits are not worth mentioning. Output only the note.`;

const fixedBy = (head: ReviewedHead, sha: string) =>
  head.reviews.flatMap((r) => r.comments.filter((c) => c.severity !== "nit").map((c) => `- ${c.severity} at ${c.path}:${c.line}: ${c.body.slice(0, 700)}\n  fixed by commit ${sha}`));

function facts(title: string, last: ReviewedHead, earlier: ReviewedHead[]) {
  const sha = last.sha.slice(0, 7);
  const caught = earlier.flatMap((h) => fixedBy(h, sha));
  return `PR: "${title}"
Latest commit ${sha}, passed review. What the review looked at:
${last.reviews.map((r) => `${r.summary}\n${r.checked.map((c) => `- ${c}`).join("\n")}\nTests: ${r.tests}`).join("\n\n")}

Problems earlier commits had that later commits fixed (the same problem may be listed twice; merge duplicates):
${caught.join("\n") || "none"}`;
}

function resultOf(out: string) {
  const parsed: unknown = JSON.parse(out);
  const result = isRecord(parsed) ? parsed["result"] : undefined;
  return typeof result === "string" ? result : "";
}

export async function compose(key: string, title: string): Promise<string | null> {
  const heads = history(key);
  const last = heads.at(-1);
  if (last === undefined) return null;
  const env = { ...process.env, GH_CONFIG_DIR: join(OUT_DIR, "no-gh"), GH_TOKEN: "", GITHUB_TOKEN: "", MAXFLOW_SESSION: "" };
  const proc = Bun.spawn(["claude", "-p", facts(title, last, heads.slice(0, -1)), "--model", MODEL, "--output-format", "json", "--system-prompt", BRIEF,
    "--tools", ""], { cwd: OUT_DIR, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), WRITE_TIMEOUT_MS);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  try {
    return clean(resultOf(out), heads.map((h) => h.sha));
  } catch {
    return null;
  }
}

const gh = (args: string[], input: string) => {
  const r = Bun.spawnSync(["gh", ...args], { stdin: Buffer.from(input), stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};

const isEdited = (repo: string, prior: Posted, payload: string) => (gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${prior.id}`, "--input", "-", "--jq", ".id"], payload) ?? "") !== "";

export function post(key: string, sha: string, body: string, prior?: Posted): Posted | null {
  const [repo = "", n = ""] = key.split("#", 2);
  const payload = JSON.stringify({ body });
  if (prior !== undefined && isEdited(repo, prior, payload)) return { id: prior.id, sha, body };
  const id = Number(gh(["api", "-X", "POST", `repos/${repo}/issues/${n}/comments`, "--input", "-", "--jq", ".id"], payload));
  return id === 0 || Number.isNaN(id) ? null : { id, sha, body };
}
