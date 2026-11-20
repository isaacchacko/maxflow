import { readStatus, readWatches, type PolledPr } from "./gh";
import type { Task } from "./model";
import { sessions } from "./sessions";
import { watchedStateFile } from "./state";
import { tasks } from "./stores";
import { judged } from "./world-session";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FINDINGS_SHOWN = 12;
const STAGE_ORDER = ["merging", "approved", "needs reviewer", "in review", "ci running", "changes requested", "ci failing", "conflict", "draft", "merged", "closed"];
const APPROVED = new Set(["approved", "merging"]);
const GREEN = new Set([...APPROVED, "needs reviewer", "in review"]);
const OWN_REPOS_WITHOUT_APPROVAL_RULES = "isaacchacko/";
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
    return { id, name: s.name, live: isLive, wait: s.wait ? `${s.wait.kind}:${s.wait.ref}` : null };
  });
}

const tasksOf = (url: string) =>
  tasks.filter((t: Task) => t.links.some((u) => u.toLowerCase() === url.toLowerCase())).map((t) => ({ id: t.id, title: t.title, status: t.status }));

const isMergeableStage = (key: string, stage: string) => (key.startsWith(OWN_REPOS_WITHOUT_APPROVAL_RULES) ? GREEN : APPROVED).has(stage);

const hours = (ms: number) => (ms >= DAY_MS ? `${Math.round(ms / DAY_MS)}d` : `${Math.round(ms / HOUR_MS)}h`);

const isWithoutLiveAgent = (row: Omit<PrRow, "stuck">) => NEEDS_AN_AGENT.has(row.stage) && row.sessions.every((s) => !s.live);
const isOnCurrentHead = (a: PrApproval | null, verdict: string): a is PrApproval => a?.verdict === verdict && a.current === true;

function approvalStuck(a: PrApproval | null, unresolved: number): string | null {
  const findingsAge = Date.now() - (a?.at ?? Date.now());
  if (isOnCurrentHead(a, "findings") && findingsAge > HOUR_MS) return `approval findings sent ${hours(findingsAge)} ago, no new push`;
  if (isOnCurrentHead(a, "passed") && unresolved > 0) return `approval passed, ${unresolved} unresolved review thread(s) block it`;
  return null;
}

function idleStuck(stage: string, since: number): string | null {
  const still = Date.now() - since;
  if (stage === "draft") return still > 3 * DAY_MS ? `draft for ${hours(still)}` : null;
  return still > DAY_MS ? `no stage change in ${hours(still)}` : null;
}

function stuckWhy(row: Omit<PrRow, "stuck">): string | null {
  if (isWithoutLiveAgent(row)) return `${row.stage} and no live agent on it`;
  return approvalStuck(row.approval, row.unresolved) ?? idleStuck(row.stage, row.since);
}

type Basis = Pick<PrRow, "url" | "title" | "stage" | "moves" | "since" | "created" | "ended"> & { known: SessionOn[] };

function openBasis(q: QueueEntry, history: History | undefined): Basis {
  const moves = history?.moves ?? [];
  const since = Date.parse(moves.at(-1)?.at ?? q.updated);
  return { url: q.url, title: q.title, stage: q.stage, moves, since, created: Date.parse(q.created), ended: null, known: [...q.sessions, ...(history?.sessions ?? [])] };
}

function endedBasis(h: History): Basis {
  const stage = h.ended?.state ?? h.moves.at(-1)?.stage ?? "unknown";
  const ended = h.ended ? Date.parse(h.ended.at) : null;
  return { url: h.url, title: h.title, stage, moves: h.moves, since: Date.parse(h.moves.at(-1)?.at ?? h.created), created: Date.parse(h.created), ended, known: h.sessions };
}

function rowOf(key: string, basis: Basis, polled: PolledPr | undefined, isOpen: boolean): PrRow {
  const { known, ...shown } = basis;
  const unresolved = unresolvedOf(polled);
  const row = {
    pr: key, ...shown, sessions: sessionsOf(key, basis.url, known), tasks: tasksOf(basis.url),
    approval: approvalOf(key, polled), failing: failingChecks(polled), unresolved,
    ready: isOpen && isMergeableStage(key, basis.stage) && unresolved === 0,
  };
  return { ...row, stuck: isOpen ? stuckWhy(row) : null };
}

function basisOf(queued: QueueEntry | undefined, history: History | undefined): Basis | undefined {
  if (queued) return openBasis(queued, history);
  return history ? endedBasis(history) : undefined;
}

const rank = (stage: string) => (STAGE_ORDER.includes(stage) ? STAGE_ORDER.indexOf(stage) : STAGE_ORDER.length);

export function prRows(): PrRow[] {
  const queue = new Map(queueFile().map((q) => [q.pr, q]));
  const history = historyFile();
  const polled = readStatus();
  const keys = new Set([...queue.keys(), ...Object.keys(history)]);
  return [...keys]
    .flatMap((key) => {
      const basis = basisOf(queue.get(key), history[key]);
      return basis ? rowOf(key, basis, polled[key], queue.has(key)) : [];
    })
    .toSorted((a, b) => rank(a.stage) - rank(b.stage) || (b.ended ?? b.since) - (a.ended ?? a.since));
}
