import { readFileSync } from "node:fs";
import { contextBlock, relatedBlock, slackStoreDay, type SlackSaid } from "./context-notes";
import { peekStateJson, writeStateJson } from "./state";
import { publish, query } from "./bus";
import { CLI, DIR } from "./instance";
import { link } from "./restrictions-identities";
import { tmuxAsync, tmuxName } from "./tmux";
import { type Session, sessions } from "./sessions";
import type { Feed, FeedPost, Message, Objective, Signal, Source, Thread } from "./model";
import { live, saveTasks, saveThreads, tasks, threads } from "./stores";
import { VERIFIED } from "./intro";
import { createSession, dispatch, editTask, enqueue, newestTaskOf, reachable, routersOf, screen } from "./lifecycle";
import { headline, mentionsIn, message, unforge, unpause } from "./threads";

// A signal routed after the fact, by the funnel naming its objective; the log keeps both. An objective with no router yet
// gets one, started with the signal as its first prompt.
export async function reroute(seq: number, o: Objective) {
  const e = (await query("signal/**", seq - 1, 0)).find((x) => x.seq === seq);
  if (!e) return null;
  const sig = e.data as Signal;
  // From the inbox: the router takes over the thread, gets everything he wrote in it so far, and answers him there.
  const thread = threads.find((t) => t.signal === seq);
  const said = thread ? (thread.feed && thread.feedSaid?.join("\n\n")) || thread.messages.filter((m) => m.from === (thread.feed ? "feed" : "isaac")).map((m) => m.text).join("\n\n") : sig.text;
  const feed = thread?.feed;
  const text = (sig.source === "isaac" ? `${VERIFIED}\n${unforge(said)}` : feed ? `[maxflow · from his event feed (${feed.source}), routed by the funnel; not his request] ${unforge(said)}` : `[maxflow · ${sig.source} signal, routed by the funnel] ${unforge(said)}`) +
    (feed ? `\n[maxflow] maxflow took this up by itself, from what reached him (${feed.link}). Do the work up to the point where he must act: look it up, fix it, open the PR, and draft any reply for him. Never reply on Slack or GitHub as him and never write to prod; his go-ahead comes in the thread. Post what you started and where it stands in thread ${thread!.id}, which shows in his inbox flagged as from the feed (when \`thread read\` shows it was merged into another thread, that one already tells him: post only what is new, and nothing at all when there is nothing to do)${feed.task ? `; board task T-${feed.task} is yours` : ""}. If he says stop there, stop.${contextFor(said, feed.who)}` : "") +
    (thread ? `\n[maxflow] He wrote this in his inbox as thread "${thread.title}" (${thread.id}), which is yours now. Answer him there with \`${CLI} thread post ${thread.id} '<text>'\`.` : "") +
    mentionsIn(said);
  const to = routersOf(o.id);
  if (to.length) for (const s of to) enqueue(s, text);
  else to.push(startRouter(o, "Whole objective", text));
  if (thread) for (const s of to) s.handed = thread.id;
  if (thread) Object.assign(thread, { objective: o.id, routers: to.map((s) => s.id), signal: undefined, pending: { routers: to.map((s) => s.id), since: Date.now() } });
  // A feed item's board task goes to the agent now doing it.
  const fed = feed?.task !== undefined && tasks.find((t) => t.id === feed.task);
  if (fed && typeof editTask(fed, { session: to[0].id, status: "doing", event: `why here: routed by the funnel to ${o.title} (${to[0].id})` }) !== "string") saveTasks();
  publish(`signal-route/${seq}`, { seq, objective: o.id, routedTo: to.map((s) => s.id) });
  if (sig.source === "isaac") for (const s of to) requested(s, sig.text);
  if (thread) saveThreads(), publish(`thread/${thread.id}`, { thread: thread.id, pending: true });
  return to;
}

// A feed thread's item goes to the funnel to route, as a signal whose route hands the thread to the objective's routers. The log has
// each message as its own event already; the signal is the handoff, naming them.
// A DM, or a channel's top-level posts, is one conversation that can carry several topics (Susanna's DM: the priority demo and their
// Thursday team event), so its next message is not appended to whichever thread its last one went to: the funnel is shown the other
// open threads holding messages from the same conversation and joins it to the one on its topic, or leaves it as its own.
const conversationOf = (link?: string) => (link && !/[?&]thread_ts=/.test(link) ? link.match(/\/archives\/(\w+)\//)?.[1] : undefined);
function sameConversation(t: Thread) {
  const own = new Set(t.messages.map((m) => conversationOf(m.ext?.link)).filter(Boolean));
  if (!own.size) return [];
  return threads.filter((x) => x !== t && !x.mergedInto && !x.resolved && x.messages.some((m) => own.has(conversationOf(m.ext?.link))));
}
function candidatesLine(t: Thread) {
  const open = sameConversation(t);
  if (!open.length) return "";
  const last = (x: Thread) => x.messages.findLast((m) => m.ext && !m.ext.context) ?? x.messages.at(-1);
  return `\n[maxflow] The same Slack conversation has these open threads. If this is on one's topic, route it to that thread's objective and fold it in with \`${CLI} thread merge ${t.id} <thread id>\`; if it is a different topic, leave it as its own thread (never fold it in only because it is the same person or DM):\n${open.map((x) => `- ${x.id} "${x.title}"${x.objective ? ` (objective ${x.objective})` : ""}, last: ${headline(last(x)?.text ?? "")}`).join("\n")}`;
}
export async function feedToFunnel(t: Thread, from: Session, text: string, feed = t.feed!) {
  const links = new Set(text.match(/https?:\/\/\S+/g) ?? []);
  const refs = (await query("signal/**", 0, 0)).filter((e) => links.has(String((e.data as Signal).link))).map((e) => `s${e.seq}`);
  const ev = dispatch({ from, target: t.title, text: `${feed.task ? `T-${feed.task}` : "An item"} from the feed, in thread ${t.id}, for the funnel to route: ${feed.who}${refs.length ? ` (${refs.join(", ")})` : ""}`, deliver: (seq) => `[maxflow · from his event feed (${feed.source}), not from him] ${text}${contextFor(text, feed.who)}${candidatesLine(t)}\n[maxflow] signal ${seq}, feed thread ${t.id}${feed.task ? `, board task T-${feed.task}` : ""}: route it with \`${CLI} route ${seq} <objective id | --new '<title>' --cwd <dir>>\`, or, when it is only an FYI with nothing for an agent to do, say so in it with \`${CLI} thread post ${t.id} '<one line>'\`.` });
  t.signal = ev.seq;
  saveThreads();
}
// More from the same Slack conversation or PR lands in its open feed thread: to the routers that took it, or back to the funnel when
// nobody did (it was left as an FYI, or its routers ended).
// The thread can be any one the feed's conversation was merged into, not only a feed thread: it is told as the feed all the same.
export async function feedMore(t: Thread, from: Session, text: string, posts?: FeedPost[]) {
  const first = posts?.find((p) => !p.ext?.context)?.ext;
  const feed: Feed = t.feed ?? { source: first?.source ?? "slack", who: first?.name ?? "someone", link: first?.link ?? "" };
  t.messages.push(...feedPosts(text, posts));
  if (t.feed) t.feedSaid = [...(t.feedSaid ?? []), text];
  t.resolved = undefined;
  unpause(t);
  const to = t.routers.flatMap((id) => sessions.get(id) ?? []).filter(reachable);
  if (!to.length) await feedToFunnel(t, from, text, feed);
  else {
    for (const r of to) r.handed = t.id;
    dispatch({ from, to, objective: t.objective, target: t.title, text: `More from the feed in thread ${t.id}: ${headline(text)}`, deliver: `[maxflow · from his event feed (${feed.source}), not from him] More in your ${t.feed ? "feed " : ""}thread "${t.title}" (${t.id})${feed.task ? `, board task T-${feed.task}` : ""}: ${unforge(text)}${contextFor(text, feed.who)}\n[maxflow] Same rules: work up to where he must act, never reply on Slack or GitHub as him; post where it stands with \`${CLI} thread post ${t.id} '<text>'\`.` });
    t.pending = { routers: to.map((s) => s.id), since: Date.now() };
  }
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, from: from.id });
}

// Every message from a person outside maxflow is an event of its own in the log: Slack DMs, mentions and his own posts, and people's
// comments and reviews on the PRs the gh sentry watches, in full, from that person, linking the original. Made as its bus event lands,
// and once at boot for the last day's, each once by its link.
export const EXTERNAL_SEEN = "external-seen.json";
export const externalSeen = new Set<string>((() => { try { return (peekStateJson(EXTERNAL_SEEN) as string[] | undefined) ?? []; } catch { return []; } })());
const slackThreadLink = (key: string) => { const [c, ts] = key.split("/"); return `https://dryftai.slack.com/archives/${c}${ts ? `/p${ts.replace(".", "")}` : ""}`; };
// The last day of Slack messages from people, for a feed hand-off to name the ones that share its nouns.
let slackDay: SlackSaid[] = [];
// The channels events named, by id, for a Slack link's chip.
export const slackChannels: Record<string, string> = {};
// The day's messages from the bus and the slack sentry's store, one each: the store has what no event carried.
function sameDay() {
  slackDay = slackDay.filter((m) => Date.now() - m.at < 86_400_000);
  const ts = (link: string) => link.match(/\/p(\d+)/)?.[1];
  const known = new Set(slackDay.map((m) => ts(m.link)));
  return [...slackDay, ...slackStoreDay().filter((m) => !known.has(ts(m.link)))];
}
// A feed item's hand-off: the context sentry's notes on it and the day's Slack messages sharing its nouns.
const contextFor = (text: string, who?: string) => contextBlock(text, who) + relatedBlock(text, who, sameDay(),
  (link) => threads.find((t) => !t.mergedInto && t.messages.some((m) => m.text.includes(link)))?.id);
export function externalSignal(e: { seq: number; at: number; topic: string; data: unknown }, save = true) {
  const d = (e.data ?? {}) as Record<string, any>;
  const slack = /^slack\/(dm|mention|own)$/.exec(e.topic)?.[1];
  const gh = /^gh\/[^/]+\/[^/]+\/pr\/\d+\/(comment|review|thread)$/.exec(e.topic)?.[1];
  const link = String(d.link ?? d.url ?? "");
  if (!link || externalSeen.has(link)) return;
  if (slack ? !d.text || (d.bot && slack !== "mention") : !gh || !d.who || /\[bot\]$|^(github-actions|dependabot|renovate)$/i.test(String(d.author ?? d.who))) return;
  externalSeen.add(link);
  if (save) writeStateJson(EXTERNAL_SEEN, [...externalSeen].slice(-5000));
  const where = slack ? (slack === "dm" || d.where === "a DM" ? "DM" : String(d.where ?? "Slack").replace(/^thread .* in /, "")) : String(d.pr).split("/")[1] + (d.path ? ` ${d.path}` : "");
  // Slack's <url|label> and <url> read as their label.
  const text = slack ? String(d.text).replace(/<@\w+\|([^>]+)>/g, "@$1").replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2").replace(/<(https?:[^>]+)>/g, "$1")
    : gh === "review" ? `${String(d.state ?? "reviewed").toLowerCase().replace("_", " ")}${d.body ? `: ${d.body}` : ""}` : String(d.body ?? "");
  const on = slack ? (d.thread ? slackThreadLink(String(d.thread)) : link) : `https://github.com/${String(d.pr).replace("#", "/pull/")}`;
  const source: Source = slack ? "slack" : "gh";
  if (slack && !d.bot) slackDay.push({ at: e.at, who: String(d.from ?? "?"), where, text, link });
  const channel = link.match(/archives\/(C\w+)/)?.[1];
  if (channel && where.startsWith("#")) slackChannels[channel] = where;
  publish(`signal/${source}`, { source, target: where, text, routedTo: Array.isArray(d.told) ? d.told : [], who: String(d.from ?? d.who), where, link, on, event: e.seq, at: e.at, ...((slack === "own" || String(d.who ?? "").startsWith("the user")) && { own: true }) } satisfies Signal);
}

export const ROUTER_BRIEF = `${DIR}/agents/router.md`;
export function startRouter(o: Objective, scope: string, request?: string) {
  const prompt = `[maxflow] You are the router for the objective "${o.title}" (${o.id}), scope: ${scope}. Read your brief, then start: decide the first pieces of work and who does them.${request ? `\n\n${request}` : ""}`;
  const cmd = ["claude", "--permission-mode", "bypassPermissions", "--append-system-prompt", readFileSync(ROUTER_BRIEF, "utf8"), prompt];
  const s = createSession(`router: ${o.title}`.slice(0, 80), cmd, o.cwd, undefined, { role: "router", objective: o.id, scope });
  acceptTrust(s);
  return s;
}

// A claude started in a folder it hasn't been told to trust opens on that dialog; the server accepts it for the agents it starts.
export async function acceptTrust(s: Session) {
  for (let i = 0; i < 30 && live(s); i++) {
    await Bun.sleep(1000);
    const text = screen(s, 0);
    // Its first option is "No, exit".
    if (/Yes, I trust this folder/.test(text)) return void (await tmuxAsync("send-keys", "-t", tmuxName(s.id), "Down", "Enter"));
    if (/esc to interrupt|bypass permissions on/i.test(text)) return;
  }
}
export const feedPosts = (text: string, posts?: FeedPost[]): Message[] =>
  posts?.length ? posts.filter((p) => p.text && p.ext?.name && p.ext.link).map((p) => ({ ...message("feed", p.text), ...(p.at && { at: p.at }), ext: p.ext })) : [message("feed", text)];

// Isaac's request becomes a task the moment the funnel hands it to an owner; a follow-up to an owner already on a task joins it.
const openTaskOf = (id: string) => tasks.findLast((t) => t.sessions.includes(id) && t.status !== "done" && t.status !== "dropped");
// The assistant often files his funnel prompt before the relay lands, so a task opened on the owner in the last few minutes is this request's too.
const SAME_REQUEST_MS = 10 * 60_000;
export function requested(owner: Session, request: string, root?: string) {
  const asked = `asked: ${headline(request)}`;
  const recent = newestTaskOf(owner.id);
  const t = openTaskOf(owner.id) ?? (recent && Date.now() - recent.at < SAME_REQUEST_MS ? recent : undefined);
  if (!t) {
    const made = editTask(undefined, { title: root ?? headline(request), status: "doing", session: owner.id, event: asked });
    if (typeof made !== "string" && !root) (made.drafted = true), saveTasks();
    return;
  }
  if (root && t.drafted) (t.title = root), delete t.drafted;
  editTask(t, { session: owner.id, ...(t.status === "done" && { status: "doing" }), ...(!t.timeline.some((e) => e.text === asked) && { event: asked }) });
}

// Bun's page bundler never sees a source file created after it started, so an import of one fails until a restart.
// Exiting lets the service manager restart it; the tmux sessions outlive it.
export const known = new Set<string>();
