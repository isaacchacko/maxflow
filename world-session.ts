import { activeAt, BLOCKED_SHOWN_MS } from "./delivery";
import { reachable } from "./lifecycle";
import { candidates } from "./mentions";
import type { GhPr, Pending, Task } from "./model";
import { type Session, type Wait, chatOf, isAgent, isSentry, sessions } from "./sessions";
import { ghStatusTable, peekStateJson, watchedStateFile } from "./state";

const BUSY_MS = 4000;
const SPINNER_GAP_MS = 10_000;
const DIALOG_SETTLE_MS = 2000;
const PENDING_GRACE_MS = 30_000;

export const isFilled = (text: string | undefined): text is string => text !== undefined && text !== "";

const isAgentWithClaudeStopped = (s: Session) => isFilled(s.asleep) || (s.claudeUp === false && (s.cmd[0] === "claude" || isFilled(chatOf(s))));

// constraint: Claude Code fires no hook on an Esc interrupt or a declined permission dialog, so silence and redraws stand in for them
function hookedClaudeStatus(claude: NonNullable<Session["claude"]>, lastOutputAt: number) {
  const quiet = Date.now() - lastOutputAt;
  if (claude.state === "working") return quiet < SPINNER_GAP_MS ? "working" : "idle";
  if (claude.state === "waiting") return lastOutputAt > claude.at + DIALOG_SETTLE_MS ? "idle" : "waiting";
  return "idle";
}

export function status(s: Session) {
  if (s.exitCode !== null) return "exited";
  if (isSentry(s) || isAgentWithClaudeStopped(s)) return "idle";
  if (s.claude === undefined) return Date.now() - s.lastOutputAt < BUSY_MS ? "working" : "idle";
  return hookedClaudeStatus(s.claude, s.lastOutputAt);
}

const verdicts = watchedStateFile<Record<string, Record<string, boolean>>>("graph-links.json", {});
export const judged = (s: Session) => candidates(s).filter((c) => verdicts()[s.id]?.[c.url] === true).map((c) => c.url);
export const links = (s: Session) => judged(s).filter((u) => prStates.get(u) !== "missing");
export const prStates = new Map<string, string>();
export const ARCHIVED_LINKS = "archived-links.json";
const archivedAtStart = peekStateJson(ARCHIVED_LINKS);
export const archivedLinks = new Set<string>(Array.isArray(archivedAtStart) ? archivedAtStart.filter((u): u is string => typeof u === "string") : []);
const groups = watchedStateFile<Record<string, string>>("graph-groups.json", {});
export const sentryTies = Object.fromEntries(["review", "gh", "slack"].map((n) => [`sentry:${n}`, watchedStateFile<{ session: string; label: string; prs?: string[] }[]>(`${n}-edges.json`, [])]));

export const localIso = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
export const taskRef = (id: number) => `t${id}`;

const isOnIt = (s?: Session) => reachable(s) && (s.inbox.length > 0 || agentState(s) === "working");
export const pendingOf = (p?: Pending) =>
  p === undefined
    ? undefined
    : { routerIds: p.routers, since: localIso(p.since), status: p.status, stale: Date.now() - p.since > PENDING_GRACE_MS && p.routers.every((id) => !isOnIt(sessions.get(id))) };
export const ghStatus = () => ghStatusTable.fresh() as Record<string, { pr: GhPr }>;

function blockedOf(s: Session) {
  const since = s.blockedSince;
  return since !== undefined && since !== 0 && s.inbox.length > 0 && Date.now() - since >= BLOCKED_SHOWN_MS ? { count: s.inbox.length, since } : null;
}

export const describe = (s: Session, shown = links(s)) => ({
  id: s.id,
  name: s.name,
  cmd: s.cmd,
  cwd: s.cwd,
  createdAt: s.createdAt,
  lastOutputAt: s.lastOutputAt,
  activeAt: activeAt(s),
  clients: s.clients.size,
  running: s.exitCode === null,
  exitCode: s.exitCode,
  chatId: s.chatId,
  transcript: s.transcript,
  pending: s.inbox.length,
  status: status(s),
  agent: isAgent(s),
  links: shown,
  archivedLinks: shown.filter((u) => archivedLinks.has(u)),
  prs: Object.fromEntries(shown.flatMap((u) => (prStates.has(u) ? [[u, prStates.get(u)]] : []))),
  group: groups()[s.id] ?? null,
  archived: s.archived === true,
  asleep: isFilled(s.asleep),
  sentry: isSentry(s),
  ties: isSentry(s) ? (sentryTies[s.name]?.() ?? []) : [],
  wait: s.wait ?? null,
  role: s.role ?? null,
  blocked: blockedOf(s),
});

export const isWaitingOnSomething = (s: Session): s is Session & { wait: Wait } => s.wait !== undefined && s.wait.kind !== "done";

export function agentState(s: Session) {
  if (s.archived === true || isFilled(s.asleep)) return isWaitingOnSomething(s) ? "waiting" : "asleep";
  const st = status(s);
  if (st === "working" || st === "waiting") return st;
  return isWaitingOnSomething(s) ? "waiting" : "idle";
}

export function stateSince(s: Session) {
  if (isWaitingOnSomething(s) && agentState(s) !== "working") return s.wait.at;
  if (s.claude?.state === agentState(s)) return s.claude.at;
  return s.lastOutputAt;
}

export function v2Status(t: Task) {
  if (t.status === "todo" || t.status === "doing") return t.status;
  if (t.status === "done" || t.status === "dropped") return "done";
  return "review";
}
