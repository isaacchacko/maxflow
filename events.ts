import { peekStateJson, writeStateJson } from "./state";
import { isOwnComment as ownComment, markRead } from "./gh";
import { type Session, type Wait, isSentry, sessions } from "./sessions";
import type { UserComment } from "./model";
import { dispatch, endWait, funnel } from "./lifecycle";
import { unforge } from "./threads";
import { ghStatus } from "./world";
import { requested } from "./routing";

// gh sentry's events that end a PR wait, and why.
function prWaitEnds(kind: Wait["kind"], event: string, data: any) {
  if (event === "merged" || event === "closed") return `the PR was ${event}`;
  if (kind === "ci" && event === "ci") return `CI ${String(data?.state).toLowerCase()}`;
  if (kind === "approval" && ((event === "review" && data?.state === "APPROVED") || (event === "decision" && data?.decision === "APPROVED"))) return "the PR is approved";
  return null;
}
// The user's own PR comment reaches the funnel as his ask, typed in unstamped like a graph double-click, so the funnel can relay it as his.
// The sessions line is marked [maxflow] so stamp() takes only his comment as the request the funnel must relay verbatim.
// Only the gh sentry's word that it is his is taken; with no funnel up, the sessions on the PR hear it from the server instead.
function commentAsk(kind: string, d: any) {
  const where = kind === "review" ? `review (${String(d.state).toLowerCase().replace("_", " ")})` : d.path ? `comment on ${d.path}` : "comment";
  const on = (d.told as string[]).flatMap((id) => sessions.get(id) ?? []).map((s) => `${s.id} (${s.name})`);
  const text = `My ${where} on PR ${d.pr}: "${String(d.body ?? "").trim()}" ${d.url ?? ""}${on.length ? `\n[maxflow] Sessions on this PR: ${on.join(", ")}` : ""}`;
  const gh = [...sessions.values()].find((s) => s.name === "sentry:gh" && isSentry(s));
  const front = funnel();
  // His own words: the log shows them as his, the funnel gets them unstamped to relay.
  if (front) dispatch({ source: "isaac", target: d.pr, to: [front], text });
  else dispatch({ source: "gh", from: gh, target: d.pr, to: (d.told as string[]).flatMap((id) => sessions.get(id) ?? []), text, deliver: `[maxflow · from "sentry:gh"] ${unforge(text)}` });
  if (d.id) markRead(d.id);
}
export function onEvent(topic: string, data: any, from?: Session) {
  const intent = topic.match(/^intent\/([\w-]+)$/);
  const owner = intent && sessions.get(intent[1]);
  if (owner && typeof data?.request === "string") requested(owner, data.request, typeof data.root === "string" ? data.root.trim() || undefined : undefined);
  // A Slack wait ends on the first new message in its thread, channel or search that someone else posted.
  if (topic.startsWith("slack/") && data?.target)
    for (const s of sessions.values()) if (s.wait?.kind === "slack" && s.wait.ref === data.target && data.told?.includes(s.id)) endWait(s, `new Slack message from ${data.from}`);
  const m = topic.match(/^gh\/[^/]+\/[^/]+\/pr\/\d+\/(\w+)$/);
  if (!m || !data?.pr) return;
  recordUserComment(m[1], data, Date.now());
  if (from?.name === "sentry:gh" && isSentry(from) && ["comment", "thread", "review"].includes(m[1]) && ownComment(data.who) && Array.isArray(data.told)) commentAsk(m[1], data);
  for (const s of sessions.values())
    if ((s.wait?.kind === "approval" || s.wait?.kind === "ci") && s.wait.ref === data.pr) {
      const why = prWaitEnds(s.wait.kind, m[1], data);
      if (why) endWait(s, why);
    }
}
const USER_COMMENTS = "user-comments.json";
const userComments: UserComment[] = (() => { try { return (peekStateJson(USER_COMMENTS) as UserComment[] | undefined) ?? []; } catch { return []; } })();
export const seedUserComments = !userComments.length;
export function recordUserComment(kind: string, data: any, at: number) {
  if ((kind !== "comment" && kind !== "thread") || !data.who?.startsWith("the user") || userComments.some((c) => c.id === data.id)) return;
  userComments.push({ id: data.id, pr: data.pr, kind, url: data.url, body: data.body, path: data.path, at });
  writeStateJson(USER_COMMENTS, userComments);
}
// Open while its PR is: a thread comment until the thread is resolved, a top-level one until someone comments after it.
export function openUserComments() {
  return userComments.flatMap((c) => {
    const pr = ghStatus()[c.pr]?.pr;
    if (pr?.state !== "OPEN") return [];
    if (c.kind === "thread") {
      const thread = pr.reviewThreads.nodes.find((t) => t.comments.nodes.some((o) => o.id === c.id));
      if (!thread || thread.isResolved) return [];
      const replies = thread.comments.nodes.length - 1 - thread.comments.nodes.findIndex((o) => o.id === c.id);
      return [{ ...c, title: pr.title, replies }];
    }
    // CI bots post plans and reports after anything, so only a person's or an agent's comment counts as an answer.
    const i = pr.comments.nodes.findIndex((o) => o.id === c.id);
    const answered = pr.comments.nodes.slice(i + 1).some((o) => !/bot\b|\[bot\]|^github-actions$/i.test(o.author?.login ?? ""));
    return i >= 0 && !answered ? [{ ...c, title: pr.title, replies: 0 }] : [];
  });
}

