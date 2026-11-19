import { peekStateJson, writeStateJson } from "./state";
import { isOwnComment as ownComment, markRead } from "./gh";
import { type Session, type Wait, isSentry, sessions } from "./sessions";
import type { UserComment } from "./model";
import { dispatch, endWait, funnel } from "./lifecycle";
import { unforge } from "./threads";
import { ghStatus } from "./world";
import { requested } from "./routing";
import { isRecord, stringOr } from "./shared/guards";

type EventData = { pr?: unknown; state?: unknown; decision?: unknown; path?: unknown; body?: unknown; url?: unknown; id?: unknown; told?: unknown; who?: unknown; request?: unknown; root?: unknown; target?: unknown; from?: unknown };
type CommentEvent = EventData & { pr: string; told: string[] };

const stringsIn = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : undefined);

const isApprovalEvent = (event: string, data: EventData) =>
  (event === "review" && data.state === "APPROVED") || (event === "decision" && data.decision === "APPROVED");
function whyGhEventEndsPrWait(kind: Wait["kind"], event: string, data: EventData) {
  if (event === "merged" || event === "closed") return `the PR was ${event}`;
  if (kind === "ci" && event === "ci") return `CI ${String(data.state).toLowerCase()}`;
  if (kind === "approval" && isApprovalEvent(event, data)) return "the PR is approved";
  return null;
}
function commentPlace(kind: string, d: CommentEvent) {
  if (kind === "review") return `review (${String(d.state).toLowerCase().replace("_", " ")})`;
  return typeof d.path === "string" && d.path !== "" ? `comment on ${d.path}` : "comment";
}
function relayHisPrCommentToFunnelUnstamped(kind: string, d: CommentEvent) {
  const toldSessions = d.told.flatMap((id) => sessions.get(id) ?? []);
  const on = toldSessions.map((s) => `${s.id} (${s.name})`);
  const sessionsLine = on.length > 0 ? `\n[maxflow] Sessions on this PR: ${on.join(", ")}` : "";
  const text = `My ${commentPlace(kind, d)} on PR ${d.pr}: "${stringOr(d.body).trim()}" ${stringOr(d.url)}${sessionsLine}`;
  const gh = sessions.values().find((s) => s.name === "sentry:gh" && isSentry(s));
  const front = funnel();
  if (front) dispatch({ source: "isaac", target: d.pr, to: [front], text });
  else dispatch({ source: "gh", ...(gh && { from: gh }), target: d.pr, to: toldSessions, text, deliver: `[maxflow · from "sentry:gh"] ${unforge(text)}` });
  if (typeof d.id === "string" && d.id !== "") void markRead(d.id);
}
function onIntent(topic: string, data: EventData) {
  const id = /^intent\/([\w-]+)$/.exec(topic)?.[1];
  const owner = id === undefined ? undefined : sessions.get(id);
  if (owner === undefined || typeof data.request !== "string") return;
  const root = typeof data.root === "string" ? data.root.trim() : "";
  requested(owner, data.request, root === "" ? undefined : root);
}
function endSlackWaitsOnFirstNewMessage(data: EventData) {
  const told = stringsIn(data.told) ?? [];
  for (const s of sessions.values()) if (s.wait?.kind === "slack" && s.wait.ref === data.target && told.includes(s.id)) endWait(s, `new Slack message from ${String(data.from)}`);
}
const isHisCommentFromGhSentry = (kind: string, data: EventData, from?: Session) =>
  from?.name === "sentry:gh" && isSentry(from) && ["comment", "thread", "review"].includes(kind) && ownComment(typeof data.who === "string" ? data.who : undefined);
function onPrEvent(kind: string, pr: string, data: EventData, from?: Session) {
  recordUserComment(kind, data, Date.now());
  const told = stringsIn(data.told);
  if (told !== undefined && isHisCommentFromGhSentry(kind, data, from)) relayHisPrCommentToFunnelUnstamped(kind, { ...data, pr, told });
  for (const s of sessions.values())
    if ((s.wait?.kind === "approval" || s.wait?.kind === "ci") && s.wait.ref === pr) {
      const why = whyGhEventEndsPrWait(s.wait.kind, kind, data);
      if (why !== null) endWait(s, why);
    }
}
export function onEvent(topic: string, payload: unknown, from?: Session) {
  const data: EventData = isRecord(payload) ? payload : {};
  onIntent(topic, data);
  if (topic.startsWith("slack/") && typeof data.target === "string" && data.target !== "") endSlackWaitsOnFirstNewMessage(data);
  const kind = /^gh\/[^/]+\/[^/]+\/pr\/\d+\/(\w+)$/.exec(topic)?.[1];
  if (kind === undefined || typeof data.pr !== "string" || data.pr === "") return;
  onPrEvent(kind, data.pr, data, from);
}
const USER_COMMENTS = "user-comments.json";
const userComments: UserComment[] = (() => { try { return (peekStateJson(USER_COMMENTS) as UserComment[] | undefined) ?? []; } catch { return []; } })();
export const seedUserComments = userComments.length === 0;
export function recordUserComment(kind: string | undefined, payload: unknown, at: number) {
  if (kind !== "comment" && kind !== "thread") return;
  const data: EventData = isRecord(payload) ? payload : {};
  if (typeof data.who !== "string" || !data.who.startsWith("the user") || userComments.some((c) => c.id === data.id)) return;
  userComments.push({ id: stringOr(data.id), pr: stringOr(data.pr), kind, url: stringOr(data.url), body: stringOr(data.body), ...(typeof data.path === "string" && { path: data.path }), at });
  writeStateJson(USER_COMMENTS, userComments);
}
const isBotLogin = (login: string) => /bot\b|\[bot\]|^github-actions$/i.test(login);
export function openUserComments() {
  return userComments.flatMap((c) => {
    const pr = ghStatus()[c.pr]?.pr;
    if (pr?.state !== "OPEN") return [];
    if (c.kind === "thread") {
      const thread = pr.reviewThreads.nodes.find((t) => t.comments.nodes.some((o) => o.id === c.id));
      if (!thread || thread.isResolved) return [];
      const replies = thread.comments.nodes.length - 1 - thread.comments.nodes.findIndex((o) => o.id === c.id);
      return { ...c, title: pr.title, replies };
    }
    const i = pr.comments.nodes.findIndex((o) => o.id === c.id);
    const isAnsweredByPersonOrAgent = pr.comments.nodes.slice(i + 1).some((o) => !isBotLogin(o.author?.login ?? ""));
    return isAnsweredByPersonOrAgent || i === -1 ? [] : { ...c, title: pr.title, replies: 0 };
  });
}
