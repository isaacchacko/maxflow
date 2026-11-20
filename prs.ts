import { readStatus, readWatches, type PolledPr } from "./gh";
import type { Task } from "./model";
import { sessions } from "./sessions";
import { watchedStateFile } from "./state";
import { tasks } from "./stores";
import { judged } from "./world-session";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const FINDINGS_SHOWN = 12;
const STAGE_ORDER = ["merging", "approved", "needs reviewer", "in review", "ci running", "changes requested", "ci failing", "conflict", "draft", "merged", "closed"];
const APPROVED = new Set(["approved", "merging"]);
const GREEN = new Set([...APPROVED, "needs reviewer", "in review"]);
const OWN_REPOS_WITHOUT_APPROVAL_RULES = /^isaacchacko\//;
const NEEDS_AN_AGENT = new Set(["ci failing", "conflict", "changes requested"]);

type SessionOn = { id: string; name: string | undefined };
type QueueEntry = { pr: string; url: string; title: string; stage: string; created: string; updated: string; sessions: SessionOn[] };
type Move = { at: string; stage: string };
type History = { url: string; title: string; created: string; moves: Move[]; sessions: SessionOn[]; ended?: { state: string; at: string } };
type Comment = { path: string; line: number; severity: string; body: string };
type LensReview = { lens: string; verdict: string; summary: string; comments: Comment[] };
type Head = { sha: string; status: string; why?: string; tier?: number; reviews?: LensReview[]; finished?: number; handed?: number };
type ApprovalState = { heads: Record<string, Head>; rounds: Record<string, number>; threadsAsked: Record<string, string> };

export type PrApproval = { verdict: string; sha: string; current: boolean | null; tier: number | null; round: number; at: number | null; summary: string; findings: Comment[] };
export type PrRow = {
  pr: string; url: string; title: string; stage: string; since: number; created: number; ended: number | null; moves: Move[];
  sessions: { id: string; name: string; live: boolean; wait: string | null }[]; tasks: { id: number; title: string; status: string }[];
  approval: PrApproval | null; failing: string[]; unresolved: number; ready: boolean; stuck: string | null;
};

const queueFile = watchedStateFile<QueueEntry[]>("review-queue.json", []);
const historyFile = watchedStateFile<Record<string, History>>("pr-history.json", {});
const approvalFile = watchedStateFile<ApprovalState>("approval-state.json", { heads: {}, rounds: {}, threadsAsked: {} });

const findingsOf = (h: Head) => (h.reviews ?? []).flatMap((r) => r.comments).filter((c) => c.severity !== "nit");
const isPassed = (h: Head) => (h.reviews?.length ?? 0) > 0 && (h.reviews ?? []).every((r) => r.verdict !== "request_changes") && findingsOf(h).length === 0;

function verdictOf(h: Head) {
  if (h.status !== "done") return h.status === "skipped" || h.status === "failed" ? `${h.status}: ${h.why ?? ""}` : h.status;
  return isPassed(h) ? "passed" : "findings";
}

function approvalOf(key: string, polled: PolledPr | undefined): PrApproval | null {
  const state = approvalFile();
  const h = state.heads[key];
  if (!h) return null;
  return {
    verdict: verdictOf(h), sha: h.sha, current: polled ? polled.pr.headRefOid === h.sha : null, tier: h.tier ?? null, round: state.rounds[key] ?? 0, at: h.finished ?? null,
    summary: (h.reviews ?? []).map((r) => `${r.lens}: ${r.summary}`).join("\n\n"),
    findings: findingsOf(h).toSorted((a, b) => Number(b.severity === "blocking") - Number(a.severity === "blocking")).slice(0, FINDINGS_SHOWN),
  };
}

function failingChecks(polled: PolledPr | undefined) {
  const contexts = polled?.pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  return contexts.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(c.conclusion ?? c.state ?? "")).map((c) => c.name ?? c.context ?? "?");
}

const unresolvedOf = (polled: PolledPr | undefined) => polled?.pr.reviewThreads.nodes.filter((t) => !t.isResolved).length ?? 0;

function sessionsOf(key: string, url: string, known: SessionOn[]) {
  const watched = readWatches().filter((w) => w.pr === key).flatMap((w) => w.sessions);
  const linking = sessions.values().filter((s) => judged(s).some((u) => u.toLowerCase() === url.toLowerCase())).map((s) => s.id);
  const ids = new Set([...known.map((s) => s.id), ...watched, ...linking]);
  return [...ids].flatMap((id) => {
    const s = sessions.get(id);
    if (!s) return [];
    const isLive = s.archived !== true || (s.wait !== undefined && s.wait.kind !== "done");
    return [{ id, name: s.name, live: isLive, wait: s.wait ? `${s.wait.kind}:${s.wait.ref}` : null }];
  });
}

const tasksOf = (url: string) =>
  tasks.filter((t: Task) => t.links.some((u) => u.toLowerCase() === url.toLowerCase())).map((t) => ({ id: t.id, title: t.title, status: t.status }));

const isMergeableStage = (key: string, stage: string) => (OWN_REPOS_WITHOUT_APPROVAL_RULES.test(key) ? GREEN : APPROVED).has(stage);

const hours = (ms: number) => (ms >= DAY_MS ? `${Math.round(ms / DAY_MS)}d` : `${Math.round(ms / HOUR_MS)}h`);

function stuckWhy(row: Omit<PrRow, "stuck">): string | null {
  const still = Date.now() - row.since;
  const a = row.approval;
  if (NEEDS_AN_AGENT.has(row.stage) && !row.sessions.some((s) => s.live)) return `${row.stage} and no live agent on it`;
  if (a?.verdict === "findings" && a.current === true && a.at !== null && Date.now() - a.at > HOUR_MS) return `approval findings sent ${hours(Date.now() - a.at)} ago, no new push`;
  if (a?.verdict === "passed" && a.current === true && row.unresolved > 0) return `approval passed, ${row.unresolved} unresolved review thread(s) block it`;
  if (row.stage === "draft" && still > 3 * DAY_MS) return `draft for ${hours(still)}`;
  if (row.stage !== "draft" && still > DAY_MS) return `no stage change in ${hours(still)}`;
  return null;
}

function rowOf(key: string, queued: QueueEntry | undefined, history: History | undefined, polled: PolledPr | undefined): PrRow {
  const url = queued?.url ?? history?.url ?? "";
  const moves = history?.moves ?? [];
  const stage = queued?.stage ?? history?.ended?.state ?? moves.at(-1)?.stage ?? "unknown";
  const unresolved = unresolvedOf(polled);
  const row = {
    pr: key, url, title: queued?.title ?? history?.title ?? "", stage, moves,
    since: Date.parse(moves.at(-1)?.at ?? queued?.updated ?? history?.created ?? ""), created: Date.parse(queued?.created ?? history?.created ?? ""),
    ended: history?.ended && !queued ? Date.parse(history.ended.at) : null,
    sessions: sessionsOf(key, url, [...(queued?.sessions ?? []), ...(history?.sessions ?? [])]), tasks: tasksOf(url),
    approval: approvalOf(key, polled), failing: failingChecks(polled), unresolved,
    ready: queued !== undefined && isMergeableStage(key, stage) && unresolved === 0,
  };
  return { ...row, stuck: queued ? stuckWhy(row) : null };
}

const rank = (stage: string) => (STAGE_ORDER.includes(stage) ? STAGE_ORDER.indexOf(stage) : STAGE_ORDER.length);

export function prRows(): PrRow[] {
  const queue = new Map(queueFile().map((q) => [q.pr, q]));
  const history = historyFile();
  const polled = readStatus();
  const keys = new Set([...queue.keys(), ...Object.keys(history)]);
  return [...keys]
    .map((key) => rowOf(key, queue.get(key), history[key], polled[key]))
    .toSorted((a, b) => rank(a.stage) - rank(b.stage) || (b.ended ?? b.since) - (a.ended ?? a.since));
}
