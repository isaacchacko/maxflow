// The PR comment the approval sentry leaves once a head of one of the user's PRs passes its review: what was checked, and what earlier
// heads' reviews caught that later commits fixed, in a teammate's plain prose. A headless claude with no GitHub credentials writes it
// from the recorded reviews; the sentry process posts it as the user, one comment per PR, edited in place on later heads. Every line
// goes through clean() first, which drops any line that names an internal (the approval arrangement, the review machinery, maxflow,
// paths, ids), so a slip in the writer's prose never reaches GitHub. Posts only while the COMMENT_SWITCH file exists.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../instance";

export const COMMENT_SWITCH = join(STATE_DIR, "approval-comment");
const OUT_DIR = join(STATE_DIR, "approval");
const MODEL = "claude-sonnet-5-5";
const WRITE_TIMEOUT_MS = 5 * 60_000;

type Finding = { path: string; line: number; severity: string; body: string };
type Reviewed = { sha: string; status: string; finished?: number; reviews?: { verdict: string; summary: string; checked: string[]; tests: string; comments: Finding[] }[] };
export type Posted = { id: number; sha: string; body: string };

// Tested against prose with code spans removed, so `domains/agent/` in backticks passes while "the agent fixed it" doesn't.
const BANNED_PROSE = [
  /liud/i, /vikas/i, /approv\w* (arrangement|endpoint|request)/i, /\bas (him|isaac)\b/i, /\bisaac\b/i, /\bthe user\b/i,
  /sentr(y|ies)/i, /\bbots?\b/i, /\bagents?\b/i, /\bAI\b/, /\bLLM/i, /claude|anthropic|openai|gpt/i, /\bmodel (wrote|review|found)/i,
  /automat(ed|ic) review/i, /review (pipeline|queue|tier|round)/i, /pipeline/i, /\btiers?\b/i, /\brounds?\b/i, /headless/i,
  /shadow mode/i, /lizard/i, /risk (tier|score)/i, /\blens(es)?\b/i, /\byarn\b/i, /maxflow/i, /\bhanded? back\b/i,
];
// Tested against the whole line, code spans included.
const BANNED_ANYWHERE = [
  /maxflow/i, /\byarn\b/i, /liud/i, /sentr(y|ies)/i, /~\//, /\/Users\//, /\/home\//, /Worktrees/i, /\.maxflow/i, /STATE_DIR/,
  /\bth-[0-9a-f]{6}\b/, /\bm-[0-9a-f]{6}\b/, /\bmf-[0-9a-f]{8}\b/, /\bt\d{2,}\b/, /approval-(log|state|notify)/,
];

// The comment with every line that trips a ban dropped. Hex runs of 7+ characters are allowed only as prefixes of this PR's
// heads (the commits a fix is cited by); any other id-like token drops its line. null when nothing worth posting survives.
export function clean(text: string, shas: string[]) {
  const known = (tok: string) => shas.some((s) => s.startsWith(tok.toLowerCase()));
  const kept = text.split("\n").filter((line) => {
    const prose = line.replace(/`[^`]*`/g, "");
    if (BANNED_PROSE.some((re) => re.test(prose)) || BANNED_ANYWHERE.some((re) => re.test(line))) return false;
    return (line.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).filter((t) => /\d/.test(t) && /[a-f]/i.test(t)).every(known);
  });
  // A bold label whose lines were all dropped goes too.
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim().replace(/^\*\*[^*\n]+:\*\*\s*(?=\n\s*\*\*|$(?![\s\S]))/gm, "").trim();
  return /checked/i.test(body) ? body : null;
}

// Every recorded head of a PR that finished with reviews, oldest first.
export function history(key: string): Reviewed[] {
  const dir = join(OUT_DIR, key.replace(/[/#]/g, "_"));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")) as Reviewed; } catch { return null; } })
    .filter((h): h is Reviewed => !!h && h.status === "done" && !!h.reviews?.length)
    .sort((a, b) => (a.finished ?? 0) - (b.finished ?? 0));
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

function facts(title: string, heads: Reviewed[]) {
  const last = heads.at(-1)!;
  // Cited by the head that passed: an earlier head's finding may still stand on the next one, but none stands on that.
  const caught = heads.slice(0, -1).flatMap((h) => h.reviews!.flatMap((r) => r.comments.filter((c) => c.severity !== "nit")
    .map((c) => `- ${c.severity} at ${c.path}:${c.line}: ${c.body.slice(0, 700)}\n  fixed by commit ${last.sha.slice(0, 7)}`)));
  return `PR: "${title}"
Latest commit ${last.sha.slice(0, 7)}, passed review. What the review looked at:
${last.reviews!.map((r) => `${r.summary}\n${r.checked.map((c) => `- ${c}`).join("\n")}\nTests: ${r.tests}`).join("\n\n")}

Problems earlier commits had that later commits fixed (the same problem may be listed twice; merge duplicates):
${caught.join("\n") || "none"}`;
}

// Writes the comment for a PR whose latest recorded head passed. null when the writer fails or nothing survives clean().
export async function compose(key: string, title: string): Promise<string | null> {
  const heads = history(key);
  if (!heads.length) return null;
  const env = { ...process.env, GH_CONFIG_DIR: join(OUT_DIR, "no-gh"), GH_TOKEN: "", GITHUB_TOKEN: "", MAXFLOW_SESSION: "" };
  const proc = Bun.spawn(["claude", "-p", facts(title, heads), "--model", MODEL, "--output-format", "json", "--system-prompt", BRIEF,
    "--tools", ""], { cwd: OUT_DIR, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), WRITE_TIMEOUT_MS);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  try { return clean(String(JSON.parse(out).result ?? ""), heads.map((h) => h.sha)); } catch { return null; }
}

const gh = (args: string[], input?: string) => {
  const r = Bun.spawnSync(["gh", ...args], { stdin: input ? Buffer.from(input) : undefined, stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};

// Posts the comment on the PR, or edits the one already posted. Returns what is now there, or null when GitHub refused.
export function post(key: string, sha: string, body: string, prior?: Posted): Posted | null {
  const [repo, n] = key.split("#");
  const payload = JSON.stringify({ body });
  if (prior && gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${prior.id}`, "--input", "-", "--jq", ".id"], payload)) return { id: prior.id, sha, body };
  const id = Number(gh(["api", "-X", "POST", `repos/${repo}/issues/${n}/comments`, "--input", "-", "--jq", ".id"], payload));
  return id ? { id, sha, body } : null;
}
