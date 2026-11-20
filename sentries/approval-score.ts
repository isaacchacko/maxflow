import { run } from "../gh";
import { isRecord } from "../shared/guards";

const RISKY = /migrat|alembic|\.sql$|erp|sap|terraform|infra|helm|k8s|kubernetes|\.github\/workflows|dockerfile|auth|permission|secret/i;
const CORE_FLOW = /\/(cases?|suggestions?|instructions?|integrations?|mail(box)?|email|erp|api\/routes?|routes?\/api)\b|frontend\/src\/client\//i;
const TEST = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]+\.py$|_test\.py$|\.(test|spec)\.[jt]sx?$/;
const CODE = /\.(py|ts|tsx|js|jsx)$/;
const UNCOUNTED = /__snapshots__\/|\.lock$|lock\.ya?ml$|routeTree\.gen\.ts$|\.gen\./;
const MAX_TIER_REASONS = 6;
const LARGE_LINES = 400;
const LARGE_FILES = 15;
const UNTESTED_LINES = 150;
const WIDE_SPREAD = 3;
const COMPLEXITY_JUMPS = 2;

export type ReviewStanding = { reviewDecision: string | null; mergeStateStatus?: string; approved: boolean };

// constraint: GitHub leaves reviewDecision null on some PRs that main's ruleset still blocks on a review, so a BLOCKED one with no approval waits too
export const isWaitingOnReview = (s: ReviewStanding) =>
  s.reviewDecision === "REVIEW_REQUIRED" || ((s.reviewDecision ?? "") === "" && s.mergeStateStatus === "BLOCKED" && !s.approved);

export type FastLane = { eligible: boolean; category: string | null; reasons: string[] };
export type Signals = {
  base: string; files: number; lines: number; fastLane: FastLane | null;
  risky: string[]; owned: string[]; complexity: string[]; churn: number; tests: boolean; spread: string[]; coreFlow: string[];
};
export type Scored = { signals: Signals; tier: number; reasons: string[] };
type Change = { path: string; lines: number };
type OwnerRule = { glob: Bun.Glob; owned: boolean };
type Inputs = { clone: string; ref: string; base: string; changes: Change[]; lane: FastLane | null; complexity: string[] };

export const isFastLane = (value: unknown): value is FastLane => isRecord(value) && typeof value["eligible"] === "boolean" && Array.isArray(value["reasons"]);
export const isReviewableCode = (path: string) => CODE.test(path) && !TEST.test(path);

const countOf = (text: string | undefined) => {
  const n = Number(text);
  return Number.isNaN(n) ? 0 : n;
};

export function changesOf(dir: string, base: string): Change[] {
  const numstat = run(["git", "-C", dir, "diff", "--numstat", "--no-renames", base, "HEAD"]);
  return numstat.split("\n").filter((l) => l !== "").map((l) => {
    const [added, deleted, path = ""] = l.split("\t", 3);
    return { path, lines: countOf(added) + countOf(deleted) };
  });
}

function codeownersGlob(pattern: string) {
  if (pattern.startsWith("/")) return pattern.slice(1);
  return pattern.includes("/") ? pattern : `**/${pattern}`;
}

function ownerRule(line: string): OwnerRule {
  const [pattern = "", ...owners] = line.split(/\s+/);
  const glob = codeownersGlob(pattern);
  return { glob: new Bun.Glob(glob.endsWith("/") ? `${glob}**` : glob), owned: owners.length > 0 };
}

function ownedGlobs(clone: string, ref: string) {
  const text = run(["git", "-C", clone, "show", `${ref}:.github/CODEOWNERS`]);
  return text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter((l) => l !== "").map(ownerRule);
}

const isOwned = (rules: OwnerRule[], path: string) => rules.findLast((r) => r.glob.match(path))?.owned ?? false;
const deniedPaths = (lane: FastLane | null) => (lane?.reasons ?? []).filter((r) => r.endsWith("on the deny list")).map((r) => r.split(":", 1)[0] ?? "");

export function signalsOf({ clone, ref, base, changes, lane, complexity }: Inputs): Signals {
  const counted = changes.filter((c) => !UNCOUNTED.test(c.path));
  const paths = changes.map((c) => c.path);
  const owners = ownedGlobs(clone, ref);
  return {
    base, files: counted.length, lines: counted.reduce((n, c) => n + c.lines, 0), fastLane: lane ? { eligible: lane.eligible, category: lane.category, reasons: lane.reasons } : null,
    risky: [...new Set([...deniedPaths(lane), ...paths.filter((p) => RISKY.test(p) && !TEST.test(p) && !UNCOUNTED.test(p))])],
    owned: paths.filter((p) => isOwned(owners, p)),
    complexity,
    churn: countOf(run(["git", "-C", clone, "rev-list", "--count", "--since=30.days", ref, "--", ...paths])),
    tests: paths.some((p) => TEST.test(p)),
    spread: [...new Set(paths.map((p) => p.split("/", 1)[0] ?? ""))],
    coreFlow: paths.filter((p) => CORE_FLOW.test(p)),
  };
}

function middleTierReasons(s: Signals) {
  return [
    s.lines > LARGE_LINES ? `${s.lines} lines` : "",
    s.files > LARGE_FILES ? `${s.files} files` : "",
    s.complexity.length >= COMPLEXITY_JUMPS ? `${s.complexity.length} complexity jumps` : "",
    s.coreFlow.length > 0 ? `core flow: ${s.coreFlow.slice(0, 2).join(", ")}` : "",
    s.spread.length >= WIDE_SPREAD ? `spans ${s.spread.join(", ")}` : "",
    !s.tests && s.lines > UNTESTED_LINES ? "no tests touched" : "",
  ].filter((r) => r !== "");
}

export function tierOf(s: Signals): Omit<Scored, "signals"> {
  if (s.risky.length > 0 || s.owned.length > 0) {
    return { tier: 3, reasons: [...s.risky.map((p) => `risky path ${p}`), ...s.owned.map((p) => `code owners own ${p}`)].slice(0, MAX_TIER_REASONS) };
  }
  if (s.fastLane?.eligible === true) return { tier: 0, reasons: [`fast lane: ${String(s.fastLane.category)}`] };
  const reasons = middleTierReasons(s);
  return reasons.length > 0 ? { tier: 2, reasons } : { tier: 1, reasons: [`${s.lines} lines, ${s.files} files, no risk signal`] };
}
