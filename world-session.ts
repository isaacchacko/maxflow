import { activeAt, BLOCKED_SHOWN_MS } from "./delivery";
import { isReachable } from "./lifecycle";
import { candidates } from "./mentions";
import type { GhPr, Pending, Task } from "./model";
import { type Session, type Wait, chatOf, isAgent, isSentry, sessions } from "./sessions";
import { isFilled } from "./shared/guards";
import { ghStatusTable, peekStateJson, watchedStateFile } from "./state";

const BUSY_MS = 4000;
const SPINNER_GAP_MS = 10_000;
const DIALOG_SETTLE_MS = 2000;
const PENDING_GRACE_MS_FOR_DELIVERY = 30_000;

const isAgentWithClaudeStoppedPrintingOnlyAPlaceholder = (s: Session) => isFilled(s.asleep) || (s.claudeUp === false && (s.cmd[0] === "claude" || isFilled(chatOf(s))));

// constraint: Claude Code fires no hook on an Esc interrupt or a declined permission dialog, so silence and redraws stand in for them
function hookedClaudeStatus(claude: NonNullable<Session["claude"]>, lastOutputAt: number) {
  const quiet = Date.now() - lastOutputAt;
  if (claude.state === "working") return quiet < SPINNER_GAP_MS ? "working" : "idle";
  if (claude.state === "waiting") return lastOutputAt > claude.at + DIALOG_SETTLE_MS ? "idle" : "waiting";
  return "idle";
}

export function status(s: Session) {
  if (s.exitCode !== null) return "exited";
  if (isSentry(s) || isAgentWithClaudeStoppedPrintingOnlyAPlaceholder(s)) return "idle";
  if (s.claude === undefined) return Date.now() - s.lastOutputAt < BUSY_MS ? "working" : "idle";
  return hookedClaudeStatus(s.claude, s.lastOutputAt);
}

const graphLinkVerdictsHidingUnjudgedUrls = watchedStateFile<Record<string, Record<string, boolean>>>("graph-links.json", {});
export const judged = (s: Session) =>
  candidates(s)
    .filter((c) => graphLinkVerdictsHidingUnjudgedUrls()[s.id]?.[c.url] === true)
    .map((c) => c.url);
export const prStates = new Map<string, string>();
const isPrGithubSaysIsMissing = (url: string) => prStates.get(url) === "missing";
export const links = (s: Session) => judged(s).filter((u) => !isPrGithubSaysIsMissing(u));
export const ARCHIVED_LINKS = "archived-links.json";
const archivedAtStart = peekStateJson(ARCHIVED_LINKS);
export const archivedLinks = new Set<string>(Array.isArray(archivedAtStart) ? archivedAtStart.filter((u): u is string => typeof u === "string") : []);
const groupOfSession = watchedStateFile<Record<string, string>>("graph-groups.json", {});
export const sentryTies = Object.fromEntries(["review", "gh", "slack"].map((n) => [`sentry:${n}`, watchedStateFile<{ session: string; label: string; prs?: string[] }[]>(`${n}-edges.json`, [])]));

export const localIsoComparedByItsDayPrefix = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
export const taskRef = (id: number) => `t${String(id)}`;

export const isWaitingOnSomething = (s: Session): s is Session & { wait: Wait } => s.wait !== undefined && s.wait.kind !== "done";

export function agentState(s: Session) {
  if (s.archived === true || isFilled(s.asleep)) return isWaitingOnSomething(s) ? "waiting" : "asleep";
  const st = status(s);
  if (st === "working" || st === "waiting") return st;
  return isWaitingOnSomething(s) ? "waiting" : "idle";
}

export function stateSinceTurnStartSleepOrLastOutput(s: Session) {
  if (isWaitingOnSomething(s) && agentState(s) !== "working") return s.wait.at;
  if (s.claude?.state === agentState(s)) return s.claude.at;
  return s.lastOutputAt;
}

export function v2Status(t: Task) {
  if (t.status === "todo" || t.status === "doing") return t.status;
  if (t.status === "done" || t.status === "dropped") return "done";
  return "review";
}

const isOnItUnlikeAShellWithAFullInbox = (s?: Session) => isReachable(s) && (s.inbox.length > 0 || agentState(s) === "working");
const hasDeclaredWait = (s?: Session): s is Session => isReachable(s) && isWaitingOnSomething(s);
export function pendingOf(p?: Pending) {
  if (p === undefined) return;
  const routers = p.routers.map((id) => sessions.get(id));
  const isUnattended = Date.now() - p.since > PENDING_GRACE_MS_FOR_DELIVERY && routers.every((s) => !isOnItUnlikeAShellWithAFullInbox(s));
  const waiter = isUnattended ? routers.find((s) => hasDeclaredWait(s)) : undefined;
  return { routerIds: p.routers, since: localIsoComparedByItsDayPrefix(p.since), status: p.status, stale: isUnattended && waiter === undefined, ...(waiter && { waitingOn: waiter.id }) };
}
export const ghStatus = (): Record<string, { pr: GhPr }> => ghStatusTable.fresh();

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
  group: groupOfSession()[s.id] ?? null,
  role: s.role ?? null,
  archived: s.archived === true,
  asleep: isFilled(s.asleep),
  sentry: isSentry(s),
  ties: isSentry(s) ? (sentryTies[s.name]?.() ?? []) : [],
  wait: s.wait ?? null,
  blocked: blockedOf(s),
});
