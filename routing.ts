import { readFileSync } from "node:fs";
import { publish, query } from "./bus";
import { contextBlock, relatedBlock, slackStoreDay, type SlackSaid } from "./context-notes";
import { CLI, DIR } from "./instance";
import { VERIFIED } from "./intro";
import { createSession, dispatch, editTask, enqueue, newestTaskOf, isReachable, routersOf, screen } from "./lifecycle";
import type { Feed, FeedPost, Message, Objective, Signal, Source, Thread } from "./model";
import { patch } from "./patch";
import { type Session, sessions } from "./sessions";
import { isRecord, stringOr } from "./shared/guards";
import { peekStateJson, writeStateJson } from "./state";
import { isLive, saveTasks, saveThreads, tasks, threads } from "./stores";
import { headline, mentionsIn, message, unforge, unpause } from "./threads";
import { tmuxAsync, tmuxName } from "./tmux";

const SLACK_DAY_MS = 86_400_000;
const EXTERNAL_SEEN_KEPT = 5000;
const TRUST_DIALOG_POLLS = 30;
const SAME_REQUEST_MS = 10 * 60_000;
const BOT_AUTHOR = /\[bot\]$|^(github-actions|dependabot|renovate)$/i;

const isFilled = (text: string | undefined): text is string => text !== undefined && text !== "";
const FALSY_JSON = new Set<unknown>([undefined, null, false, "", 0]);
const isTruthyJson = (value: unknown) => !FALSY_JSON.has(value);
const hasTask = (feed: Feed): feed is Feed & { task: number } => feed.task !== undefined && feed.task !== 0;

function saidIn(thread: Thread | undefined, sig: Signal) {
  if (thread === undefined) return sig.text;
  const fedSaid = thread.feed === undefined ? undefined : thread.feedSaid?.join("\n\n");
  if (isFilled(fedSaid)) return fedSaid;
  return thread.messages
    .filter((m) => m.from === (thread.feed ? "feed" : "isaac"))
    .map((m) => m.text)
    .join("\n\n");
}

function handoffOpening(sig: Signal, feed: Feed | undefined, said: string) {
  if (sig.source === "isaac") return `${VERIFIED}\n${unforge(said)}`;
  if (feed) return `[yarn · from his event feed (${feed.source}), routed by the funnel; not his request] ${unforge(said)}`;
  return `[yarn · ${sig.source} signal, routed by the funnel] ${unforge(said)}`;
}

const feedInstructions = (feed: Feed, thread: Thread, said: string) =>
  `\n[yarn] yarn took this up by itself, from what reached him (${feed.link}). Do the work up to the point where he must act: look it up, fix it, open the PR, and draft any reply for him. Never reply on Slack or GitHub as him and never write to prod; his go-ahead comes in the thread. Post what you started and where it stands in thread ${thread.id}, which shows in his inbox flagged as from the feed (when \`thread read\` shows it was merged into another thread, that one already tells him: post only what is new, and nothing at all when there is nothing to do)${hasTask(feed) ? `; board task T-${feed.task} is yours` : ""}. If he says stop there, stop.${contextFor(said, feed.who)}`;

const threadNote = (thread: Thread | undefined) => (thread ? `\n[yarn] He wrote this in his inbox as thread "${thread.title}" (${thread.id}), which is yours now. Answer him there with \`${CLI} thread post ${thread.id} '<text>'\`.` : "");

export async function handoff(seq: number) {
  const e = (await query("signal/**", seq - 1, 0)).find((x) => x.seq === seq);
  if (!e) return null;
  const sig = e.data as Signal;
  const thread = threads.find((t) => t.signal === seq);
  const said = saidIn(thread, sig);
  const feed = thread?.feed;
  const feedNote = thread?.feed === undefined ? "" : feedInstructions(thread.feed, thread, said);
  const text = handoffOpening(sig, feed, said) + feedNote + threadNote(thread) + mentionsIn(said);
  return { seq, sig, text, thread, feed };
}

function giveFeedTaskToRouter(feed: Feed | undefined, owner: Session | undefined, o: Objective) {
  const fed = feed?.task === undefined ? undefined : tasks.find((t) => t.id === feed.task);
  if (fed === undefined || owner === undefined) return;
  if (typeof editTask(fed, { session: owner.id, status: "doing", event: `why here: routed by the funnel to ${o.title} (${owner.id})` }) !== "string") saveTasks();
}

export async function reroute(seq: number, o: Objective) {
  const h = await handoff(seq);
  if (!h) return null;
  const { sig, text, thread, feed } = h;
  const existing = routersOf(o.id);
  for (const s of existing) enqueue(s, text);
  const to = existing.length > 0 ? existing : [startRouter(o, "Whole objective", text)];
  if (thread) {
    for (const s of to) s.handed = thread.id;
    patch(thread, { objective: o.id, routers: to.map((s) => s.id), signal: undefined, pending: { routers: to.map((s) => s.id), since: Date.now() } });
  }
  giveFeedTaskToRouter(feed, to[0], o);
  publish(`signal-route/${seq}`, { seq, objective: o.id, routedTo: to.map((s) => s.id) });
  if (sig.source === "isaac") for (const s of to) requested(s, sig.text);
  if (thread) {
    saveThreads();
    publish(`thread/${thread.id}`, { thread: thread.id, pending: true });
  }
  return to;
}

const conversationOf = (link: string | undefined) => (isFilled(link) && !/[?&]thread_ts=/.test(link) ? /\/archives\/(\w+)\//.exec(link)?.[1] : undefined);

function sameConversation(t: Thread) {
  const own = new Set(t.messages.map((m) => conversationOf(m.ext?.link)).filter(isFilled));
  if (own.size === 0) return [];
  const isInOwnConversation = (m: Message) => {
    const conversation = conversationOf(m.ext?.link);
    return conversation !== undefined && own.has(conversation);
  };
  return threads.filter((x) => x !== t && !isFilled(x.mergedInto) && x.resolved === undefined && x.messages.some(isInOwnConversation));
}

export const sizeFirst = (seq: number) =>
  `size it first with \`${CLI} size ${seq} direct|area|fyi|ignore\` (direct: one worker on it; fyi: --note '<one line>'); only area is then routed, with \`${CLI} route ${seq} <objective id | --new '<title>' --cwd <dir>>\`.`;
function ownerOf(t: Thread) {
  if (t.objective !== "") return ` (objective ${t.objective})`;
  return t.routers.length > 0 ? ` (direct worker ${t.routers.join(", ")})` : "";
}

const lastExternal = (x: Thread) => x.messages.findLast((m) => m.ext !== undefined && m.ext.context !== true) ?? x.messages.at(-1);

function candidatesLine(t: Thread) {
  const open = sameConversation(t);
  if (open.length === 0) return "";
  return `\n[yarn] The same Slack conversation has these other open threads, from its earlier bursts. If this continues one's topic, give it to that thread's owner (size it area and route it to that thread's objective, or, when a direct worker holds it, \`${CLI} notify <worker id>\` it), then fold it in with \`${CLI} thread merge ${t.id} <thread id>\`. If it is a different topic, size and route it on its own: the same person or DM is never a reason to merge:\n${open.map((x) => `- ${x.id} "${x.title}"${ownerOf(x)}, last: ${headline(lastExternal(x)?.text ?? "")}`).join("\n")}`;
}

export async function feedToFunnel(t: Thread, from: Session, text: string, feed = t.feed) {
  if (feed === undefined) return;
  const links = new Set(text.match(/https?:\/\/\S+/g));
  const refs = (await query("signal/**", 0, 0)).filter((e) => links.has(String((e.data as Signal).link))).map((e) => `s${e.seq}`);
  const ev = dispatch({ from, target: t.title, text: `${hasTask(feed) ? `T-${feed.task}` : "An item"} from the feed, in thread ${t.id}, for the funnel to route: ${feed.who}${refs.length > 0 ? ` (${refs.join(", ")})` : ""}`, deliver: (seq) => `[yarn · from his event feed (${feed.source}), not from him] ${text}${contextFor(text, feed.who)}${candidatesLine(t)}\n[yarn] signal ${seq}, feed thread ${t.id}${hasTask(feed) ? `, board task T-${feed.task}` : ""}: ${sizeFirst(seq)}` });
  patch(t, { signal: ev.seq });
  saveThreads();
}

const AWAITING_FUNNEL_MS = 30 * 60_000;
async function isAwaitingFunnel(t: Thread) {
  if (t.signal === undefined) return false;
  const signal = (await query("signal/**", t.signal - 1, 0)).find((e) => e.seq === t.signal);
  return signal !== undefined && Date.now() - signal.at < AWAITING_FUNNEL_MS;
}

function feedOf(t: Thread, posts: FeedPost[] | undefined): Feed {
  const first = posts?.find((p) => p.ext.context !== true)?.ext;
  return t.feed ?? { source: first?.source ?? "slack", who: first?.name ?? "someone", link: first?.link ?? "" };
}

function tellRoutersMore(t: Thread, { from, to, text, feed }: { from: Session; to: Session[]; text: string; feed: Feed }) {
  for (const r of to) r.handed = t.id;
  dispatch({ from, to, objective: t.objective, target: t.title, text: `More from the feed in thread ${t.id}: ${headline(text)}`, deliver: `[yarn · from his event feed (${feed.source}), not from him] More in your ${t.feed ? "feed " : ""}thread "${t.title}" (${t.id})${hasTask(feed) ? `, board task T-${feed.task}` : ""}: ${unforge(text)}${contextFor(text, feed.who)}\n[yarn] Same rules: work up to where he must act, never reply on Slack or GitHub as him; post where it stands with \`${CLI} thread post ${t.id} '<text>'\`.` });
  patch(t, { pending: { routers: to.map((s) => s.id), since: Date.now() } });
}

export async function feedMore(t: Thread, from: Session, text: string, posts?: FeedPost[]) {
  const feed = feedOf(t, posts);
  t.messages.push(...feedPosts(text, posts));
  if (t.feed) patch(t, { feedSaid: [...(t.feedSaid ?? []), text] });
  patch(t, { resolved: undefined });
  unpause(t);
  const to = t.routers.flatMap((id) => sessions.get(id) ?? []).filter(isReachable);
  if (to.length > 0) tellRoutersMore(t, { from, to, text, feed });
  else if (!(await isAwaitingFunnel(t))) await feedToFunnel(t, from, text, feed);
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, from: from.id });
}

export const EXTERNAL_SEEN = "external-seen.json";
const externalSeenAtStart = peekStateJson(EXTERNAL_SEEN);
export const externalSeen = new Set<string>(Array.isArray(externalSeenAtStart) ? externalSeenAtStart.filter((link): link is string => typeof link === "string") : []);
function slackThreadLink(key: string) {
  const [channel = "", ts] = key.split("/", 2);
  return `https://dryftai.slack.com/archives/${channel}${isFilled(ts) ? `/p${ts.replace(".", "")}` : ""}`;
}
const slackDay: SlackSaid[] = [];
export const slackChannels: Record<string, string> = {};
const slackTs = (link: string) => /\/p(\d+)/.exec(link)?.[1];
function sameDay() {
  const fresh = slackDay.filter((m) => Date.now() - m.at < SLACK_DAY_MS);
  slackDay.splice(0, slackDay.length, ...fresh);
  const known = new Set(slackDay.map((m) => slackTs(m.link)));
  return [...slackDay, ...slackStoreDay().filter((m) => !known.has(slackTs(m.link)))];
}
const contextFor = (text: string, who?: string) =>
  contextBlock(text, who) +
  relatedBlock(text, who, sameDay(), (link) => threads.find((t) => !isFilled(t.mergedInto) && t.messages.some((m) => m.text.includes(link)))?.id);

type ExternalKind = { slack: string | undefined; gh: string | undefined };

function isUnwanted(d: Record<string, unknown>, { slack, gh }: ExternalKind) {
  if (isFilled(slack)) return !isTruthyJson(d["text"]) || (isTruthyJson(d["bot"]) && slack !== "mention");
  return !isFilled(gh) || !isTruthyJson(d["who"]) || BOT_AUTHOR.test(String(d["author"] ?? d["who"]));
}

function whereOf(d: Record<string, unknown>, slack: string | undefined) {
  if (!isFilled(slack)) return `${String(d["pr"]).split("/", 2)[1] ?? ""}${isTruthyJson(d["path"]) ? ` ${String(d["path"])}` : ""}`;
  return slack === "dm" || d["where"] === "a DM" ? "DM" : stringOr(d["where"], "Slack").replace(/^thread .* in /, "");
}

const slackPlainText = (text: string) =>
  text
    .replaceAll(/<@\w+\|([^>]+)>/g, "@$1")
    .replaceAll(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replaceAll(/<(https?:[^>]+)>/g, "$1");

function textOf(d: Record<string, unknown>, { slack, gh }: ExternalKind) {
  if (isFilled(slack)) return slackPlainText(String(d["text"]));
  if (gh !== "review") return stringOr(d["body"]);
  return `${stringOr(d["state"], "reviewed").toLowerCase().replace("_", " ")}${isTruthyJson(d["body"]) ? `: ${String(d["body"])}` : ""}`;
}

function onOf(d: Record<string, unknown>, slack: string | undefined, link: string) {
  if (!isFilled(slack)) return `https://github.com/${String(d["pr"]).replace("#", "/pull/")}`;
  return isTruthyJson(d["thread"]) ? slackThreadLink(String(d["thread"])) : link;
}

function recordChannel(link: string, where: string) {
  const channel = /archives\/(C\w+)/.exec(link)?.[1];
  if (isFilled(channel) && where.startsWith("#")) slackChannels[channel] = where;
}

const kindOf = (topic: string): ExternalKind => ({
  slack: /^slack\/(dm|mention|own)$/.exec(topic)?.[1],
  gh: /^gh\/[^/]+\/[^/]+\/pr\/\d+\/(comment|review|thread)$/.exec(topic)?.[1],
});

const toldIds = (told: unknown) => (Array.isArray(told) ? told.filter((id): id is string => typeof id === "string") : []);

function newExternalLink(d: Record<string, unknown>, kind: ExternalKind) {
  const link = stringOr(d["link"] ?? d["url"]);
  if (!link || externalSeen.has(link) || isUnwanted(d, kind)) return;
  return link;
}

export function externalSignal(e: { seq: number; at: number; topic: string; data: unknown }, shouldSave = true) {
  const d = isRecord(e.data) ? e.data : {};
  const kind = kindOf(e.topic);
  const link = newExternalLink(d, kind);
  if (link === undefined) return;
  externalSeen.add(link);
  if (shouldSave) writeStateJson(EXTERNAL_SEEN, [...externalSeen].slice(-EXTERNAL_SEEN_KEPT));
  const where = whereOf(d, kind.slack);
  const text = textOf(d, kind);
  const isSlack = isFilled(kind.slack);
  const source: Source = isSlack ? "slack" : "gh";
  if (isSlack && !isTruthyJson(d["bot"])) slackDay.push({ at: e.at, who: stringOr(d["from"], "?"), where, text, link });
  recordChannel(link, where);
  const isOwn = kind.slack === "own" || stringOr(d["who"]).startsWith("the user");
  publish(`signal/${source}`, {
    source,
    target: where,
    text,
    routedTo: toldIds(d["told"]),
    who: String(d["from"] ?? d["who"]),
    where,
    link,
    on: onOf(d, kind.slack, link),
    event: e.seq,
    at: e.at,
    ...(isOwn && { own: true }),
  } satisfies Signal);
}

export const ROUTER_BRIEF = `${DIR}/agents/router.md`;
export function startRouter(o: Objective, scope: string, request?: string) {
  const prompt = `[yarn] You are the router for the objective "${o.title}" (${o.id}), scope: ${scope}. Read your brief, then start: decide the first pieces of work and who does them.${isFilled(request) ? `\n\n${request}` : ""}`;
  const cmd = ["claude", "--permission-mode", "bypassPermissions", "--append-system-prompt", readFileSync(ROUTER_BRIEF, "utf8"), prompt];
  const s = createSession(`router: ${o.title}`.slice(0, 80), cmd, o.cwd, { role: { role: "router", objective: o.id, scope } });
  void acceptTrust(s);
  return s;
}

export async function acceptTrust(s: Session) {
  for (let i = 0; i < TRUST_DIALOG_POLLS && isLive(s); i++) {
    await Bun.sleep(1000);
    const text = screen(s, 0);
    // constraint: Claude Code's folder trust dialog opens on "No, exit", so Down then Enter accepts it
    if (text.includes("Yes, I trust this folder")) {
      await tmuxAsync("send-keys", "-t", tmuxName(s.id), "Down", "Enter");
      return;
    }
    if (/esc to interrupt|bypass permissions on/i.test(text)) return;
  }
}

const sentAt = (at: number | undefined) => (at === undefined || at === 0 ? {} : { at });
export const feedPosts = (text: string, posts?: FeedPost[]): Message[] =>
  posts !== undefined && posts.length > 0
    ? posts.filter((p) => p.text && p.ext.name && p.ext.link).map((p) => ({ ...message("feed", p.text), ...sentAt(p.at), ext: p.ext }))
    : [message("feed", text)];

const openTaskOf = (id: string) => tasks.findLast((t) => t.sessions.includes(id) && t.status !== "done" && t.status !== "dropped");
function taskOfThisRequest(ownerId: string) {
  const recent = newestTaskOf(ownerId);
  return openTaskOf(ownerId) ?? (recent && Date.now() - recent.at < SAME_REQUEST_MS ? recent : undefined);
}
export function requested(owner: Session, request: string, root?: string) {
  const asked = `asked: ${headline(request)}`;
  const t = taskOfThisRequest(owner.id);
  if (!t) {
    const made = editTask(undefined, { title: root ?? headline(request), status: "doing", session: owner.id, event: asked });
    if (typeof made !== "string" && !isFilled(root)) {
      made.drafted = true;
      saveTasks();
    }
    return;
  }
  if (isFilled(root) && t.drafted === true) {
    t.title = root;
    delete t.drafted;
  }
  editTask(t, { session: owner.id, ...(t.status === "done" && { status: "doing" }), ...(t.timeline.every((e) => e.text !== asked) && { event: asked }) });
}

// constraint: Bun's page bundler never sees a source file created after it started, so importing one fails until a restart
export const known = new Set<string>();
