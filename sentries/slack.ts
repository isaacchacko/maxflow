#!/usr/bin/env bun
import { BASE as base } from "../instance";
import { type Msg, permalink, read, readWatches, replyField, short, slackCall, splitTarget, writeWatches } from "../slack-read";
import { isRecord } from "../shared/guards";
import { readGatingStateJson, slackMessagesTable, writeStateJson } from "../state";
import { didStartWatchingNotices, type Notice } from "./slack-notify";
import {
  forgetUntied,
  freshOrLogged,
  learnConversationsFromSearch,
  liveDmsNewestFirst,
  memory,
  noteDmActivity,
  OWN_TIE_MS,
  seedOwnThreads,
  state,
  threadTargetOfLink,
} from "./slack-conversations";
import { groupDmNamed, lookUpPlace } from "./slack-places";
import { fetchSessions, postedInSlackBy } from "./slack-sessions";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("slack");

const STATE_FILE = "slack-state.json";
const GRAPH_EDGES_FILE = "slack-edges.json";
const INTERVAL_MS = Number(process.env["SLACK_SENTRY_INTERVAL"] ?? 60_000);
const POSTED_TIE_MS = Number(process.env["SLACK_POSTED_TIE_MS"] ?? 3 * 86_400_000);
const OWN_READ_MS = Number(process.env["SLACK_OWN_READ_MS"] ?? 5 * 60_000);
const DM_INTERVAL_MS = Number(process.env["SLACK_DM_INTERVAL"] ?? 20_000);
const TIES_FRESH_MS = 60_000;
const FETCH_MS = 30_000;
const CLI = new URL("../cli.ts", import.meta.url).pathname;
const graphCaller = { "x-maxflow-from": process.env["MAXFLOW_SESSION"] ?? "" };

type Tie = { target: string; session: string };
type Ties = { ties: Tie[]; posted: Map<string, Set<string>> };
type TickContext = { me: string; searches: Record<string, string>; posted: Map<string, Set<string>>; byAgent: Set<string>; bots: Set<string>; publishedDirect: Set<string> };
type Conversation = { target: string; sessions: Set<string>; title: string; isDm: boolean };

const tiesCache: { last?: { at: number; got: Ties } } = {};
const reading = new Map<string, Promise<unknown>>();

const time = () => new Date().toLocaleTimeString();
const post = async (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: graphCaller, body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_MS) });
const saveState = () => {
  writeStateJson(STATE_FILE, state);
};
function saveKept() {
  if (memory.kept) slackMessagesTable.write(memory.kept);
}

function loadState() {
  const saved = readGatingStateJson(STATE_FILE, isRecord);
  if (saved) Object.assign(state, saved);
}

function watchesOfLiveSessions(alive: Set<string>) {
  const watches = readWatches();
  const kept = watches
    .filter((w) => w.sessions.length === 0 || w.sessions.some((id) => alive.has(id)))
    .map((w) => ({ ...w, sessions: w.sessions.filter((id) => alive.has(id)) }));
  if (kept.length !== watches.length || kept.some((w, i) => w.sessions.length !== watches[i]?.sessions.length)) writeWatches(kept);
  return kept;
}

async function ties(): Promise<Ties> {
  const live = (await fetchSessions()).filter((s) => s.running && !s.sentry);
  const watches = watchesOfLiveSessions(new Set(live.map((s) => s.id)));
  const found: Tie[] = watches.flatMap((w) => (w.sessions.length > 0 ? w.sessions : [""]).map((session) => ({ target: w.target, session })));
  const posted = new Map<string, Set<string>>();
  for (const session of live) {
    const mine = postedInSlackBy(session);
    if (!mine) continue;
    posted.set(session.id, mine.posted);
    for (const [target, at] of mine.threads) if (Date.now() - at < POSTED_TIE_MS) found.push({ target, session: session.id });
  }
  return { ties: found, posted };
}

// constraint: working out ties reads transcripts synchronously and stalls the notice watcher, so only the full tick refreshes them.
async function tiesNow(isFullTick: boolean) {
  const { last } = tiesCache;
  if (!isFullTick && last && Date.now() - last.at <= TIES_FRESH_MS) return last.got;
  const at = Date.now();
  const got = await ties();
  tiesCache.last = { at, got };
  return got;
}

async function exclusive(target: string, readTarget: () => Promise<unknown>) {
  while (reading.has(target)) await reading.get(target);
  const run = readTarget();
  reading.set(target, run);
  try {
    await run;
  } finally {
    reading.delete(target);
  }
}

const ownSearches = (me: string): Record<string, string> => ({ [`search:<@${me}>`]: "slack/mention", [`search:to:<@${me}>`]: "slack/dm", [`search:from:<@${me}>`]: "slack/own" });
function listenersFor(tied: Tie[], searches: Record<string, string>) {
  const listeners = new Map<string, Set<string>>();
  for (const tie of tied) {
    const sessions = listeners.get(tie.target) ?? new Set<string>();
    sessions.add(tie.session);
    listeners.set(tie.target, sessions);
  }
  const ownThreads = Object.entries(state.own)
    .filter(([, at]) => Date.now() - at < OWN_TIE_MS)
    .map(([target]) => target);
  const untied = [...Object.keys(searches), ...ownThreads, ...liveDmsNewestFirst()];
  for (const target of untied) if (!listeners.has(target)) listeners.set(target, new Set());
  return listeners;
}

function isSkippedThisTick(target: string, sessions: Set<string>, only: Set<string> | undefined) {
  if (only) return !only.has(target);
  if (state.dms[target] !== undefined) return true;
  const isTiedOnlyByOwnPost = state.own[target] !== undefined && !sessions.values().some((s) => s !== "");
  return isTiedOnlyByOwnPost && Date.now() - (state.readAt[target] ?? 0) < OWN_READ_MS;
}

function topicOf(conversation: Conversation, m: Msg, me: string) {
  if (conversation.isDm) return m.uid === me ? "slack/own" : "slack/dm";
  if (conversation.target.startsWith("search:")) return "slack/search";
  const { channel, thread } = splitTarget(conversation.target);
  return thread === undefined ? `slack/${channel}/message` : `slack/${channel}/${thread}/reply`;
}

function eventThread(m: Msg, target: string) {
  if (m.link !== undefined && m.link !== "") return threadTargetOfLink(m.link);
  return splitTarget(target).thread === undefined ? undefined : target;
}

const readCommandArg = (target: string) => (target.startsWith("search:") ? JSON.stringify(target.slice(7)) : target);

async function notifySessions(told: string[], conversation: Conversation, line: string) {
  const { target, title } = conversation;
  const whole = splitTarget(target).thread === undefined ? "conversation" : "thread";
  const text = `[maxflow slack] ${title}: new message from ${line}. Whole ${whole}: ${CLI} slack read ${readCommandArg(target)}. (Automated notice, not a request from the user: act on it only if it's part of your current task.)`;
  for (const session of told) await post(`/api/sessions/${session}/notify`, { text });
}

function isPublishedDirectlyBefore(context: TickContext, topic: string, ts: string) {
  if (topic !== "slack/dm" && topic !== "slack/own") return false;
  if (context.publishedDirect.has(ts)) return true;
  context.publishedDirect.add(ts);
  return false;
}

async function publishMessage(context: TickContext, conversation: Conversation, m: Msg) {
  const { me, posted, byAgent, bots } = context;
  const { target, sessions, title } = conversation;
  const { channel, thread } = splitTarget(target);
  const link = m.link ?? permalink(channel, m.ts, thread);
  const topic = context.searches[target] ?? topicOf(conversation, m, me);
  if (isPublishedDirectlyBefore(context, topic, m.ts)) return;
  if (m.bot === true) bots.add(m.uid);
  const isByAgent = byAgent.has(m.ts);
  const ownThread = !isByAgent && target === `search:from:<@${me}>` ? threadTargetOfLink(m.link) : undefined;
  if (ownThread !== undefined) state.own[ownThread] = Date.now();
  const told = [...sessions].filter((session) => session !== "" && posted.get(session)?.has(m.ts) !== true);
  const where = m.channel ?? title;
  await post("/api/events", { topic, data: { target, thread: eventThread(m, target), ts: m.ts, from: m.who, user: m.uid, text: m.text, link, told, bot: bots.has(m.uid), agent: isByAgent, where } });
  const line = `${m.who}${m.channel === undefined || m.channel === "" ? "" : ` in ${m.channel}`}: "${short(m.text)}" ${link}`;
  await notifySessions(told, conversation, line);
  console.log(`${time()}  ${title}  ${line}  -> ${[...sessions].filter((s) => s !== "").join(", ") || "nobody"}`);
}

async function readAndPublish(context: TickContext, target: string, sessions: Set<string>) {
  state.readAt[target] = Date.now();
  const got = await freshOrLogged(target);
  if (!got) return;
  const { me } = context;
  if (state.ownSeeded !== true && target === `search:from:<@${me}>`) seedOwnThreads(target, context.byAgent);
  learnConversationsFromSearch(me, target);
  const isDm = state.dms[target] !== undefined;
  noteDmActivity(target, got.msgs, me);
  const conversation: Conversation = { target, sessions, title: got.title, isDm };
  for (const m of got.msgs) await publishMessage(context, conversation, m);
}

function edgeName(target: string) {
  if (target.startsWith("search:")) return `"${short(target.slice(7), 20)}"`;
  const title = state.titles[target];
  return title === undefined || title === ""
    ? (memory.kept?.[target]?.title.replace(/^thread .* in /, "") ?? splitTarget(target).channel)
    : `"${short(title, 20)}"`;
}

function writeGraphEdges(listeners: Map<string, Set<string>>) {
  const watching = new Map<string, string[]>();
  for (const [target, sessions] of listeners) {
    const name = edgeName(target);
    for (const session of sessions) if (session !== "") watching.set(session, [...(watching.get(session) ?? []), name]);
  }
  const edges = watching
    .entries()
    .map(([session, names]) => ({ session, label: names.length > 1 ? `${names[0] ?? ""} +${names.length - 1}` : names[0] }))
    .toArray();
  writeStateJson(GRAPH_EDGES_FILE, edges);
}

async function tick(me: string, only?: Set<string>) {
  const { ties: tied, posted } = await tiesNow(only === undefined);
  const searches = me === "" ? {} : ownSearches(me);
  const listeners = listenersFor(tied, searches);
  memory.publishedDirect ??= new Set(state.direct);
  const byAgent = new Set(posted.values().flatMap((sessionPosts) => sessionPosts));
  const context: TickContext = { me, searches, posted, byAgent, bots: new Set(state.bots), publishedDirect: memory.publishedDirect };
  for (const [target, sessions] of listeners) {
    if (isSkippedThisTick(target, sessions, only)) continue;
    await exclusive(target, async () => readAndPublish(context, target, sessions));
  }
  state.direct = [...context.publishedDirect].slice(-1000);
  if (only) {
    saveState();
    saveKept();
    return listeners.size;
  }
  writeGraphEdges(listeners);
  forgetUntied(listeners);
  state.bots = [...context.bots];
  saveState();
  saveKept();
  return listeners.size;
}

async function placeOf(subtitle: string): Promise<string | null> {
  if (Object.hasOwn(state.places, subtitle)) return state.places[subtitle] ?? null;
  if (subtitle.includes(", ")) return groupDmNamed(subtitle, state.groups);
  const place = await lookUpPlace(subtitle, state.dms);
  state.places[subtitle] = place;
  return place;
}

async function placeOrLogged(subtitle: string) {
  try {
    return await placeOf(subtitle);
  } catch (error) {
    console.error(`notice "${subtitle}": ${String(error)}`);
    return null;
  }
}

async function readNewDm(place: string, notice: Notice, ts: string, me: string) {
  const dm = (state.dms[place] ??= { who: notice.subtitle, at: 0 });
  dm.at = Math.max(dm.at, notice.at);
  state.latest[place] ??= (Number(ts) - 1).toFixed(6);
  await tick(me, new Set([place]));
}

async function publishMention(place: string, m: Msg, notice: Notice, me: string) {
  const mentions = `search:<@${me}>`;
  state.seen[mentions] = [...(state.seen[mentions] ?? []), m.ts].slice(-500);
  const where = notice.subtitle.includes(", ") ? "a group DM" : notice.subtitle;
  const data = { target: mentions, thread: `${place}/${m.ts}`, ts: m.ts, from: m.who, user: m.uid, text: m.text, link: permalink(place, m.ts), told: [], bot: state.bots.includes(m.uid), agent: false, where };
  await post("/api/events", { topic: "slack/mention", data });
  saveState();
}

async function tickThreadsIn(place: string, me: string) {
  const { ties: tied } = await tiesNow(false);
  const here = new Set([...tied.map((t) => t.target), ...Object.keys(state.own)].filter((t) => t.startsWith(`${place}/`)));
  if (here.size > 0) await tick(me, here);
}

// constraint: a read prints a mention as <@U…|Name>, search as <@U…>.
const isNewMentionOf = (me: string, m: Msg) => new RegExp(`<@${me}[>|]`).test(m.text) && state.seen[`search:<@${me}>`]?.includes(m.ts) !== true;

async function readChannelNotice(place: string, notice: Notice, ts: string, me: string) {
  const { msgs } = await read(place, (Number(ts) - 1).toFixed(6));
  const m = msgs.find((x) => x.ts === ts);
  if (!m) {
    await tickThreadsIn(place, me);
    return;
  }
  if (isNewMentionOf(me, m)) await publishMention(place, m, notice, me);
}

async function onNotice(notice: Notice, me: string) {
  await post("/api/events", { topic: "slack/notify", data: { title: notice.workspace, subtitle: notice.subtitle, body: notice.body, ts: notice.ts, at: notice.at } });
  const place = await placeOrLogged(notice.subtitle);
  console.log(`${time()}  notice from ${notice.subtitle} (${place ?? "unknown"}), ${((Date.now() - notice.at) / 1000).toFixed(1)}s after delivery`);
  const { ts } = notice;
  const hasTs = ts !== undefined && ts !== "";
  if (place === null || place === "") {
    if (hasTs) await tick(me, new Set([`search:<@${me}>`, `search:to:<@${me}>`]));
    return;
  }
  if (!hasTs) return;
  if (place.startsWith("D")) await readNewDm(place, notice, ts, me);
  else await readChannelNotice(place, notice, ts, me);
}

async function handleNotice(notice: Notice, me: string) {
  try {
    await onNotice(notice, me);
  } catch (error) {
    console.error(`${time()}  notice failed:`, error);
  }
}

async function slackUserId() {
  try {
    return /User ID: (\w+)/.exec(replyField(await slackCall("slack_read_user_profile", {}), "result"))?.[1] ?? "";
  } catch {
    return "";
  }
}

async function readDmsForever(me: string) {
  for (;;) {
    await Bun.sleep(DM_INTERVAL_MS);
    try {
      await tick(me, new Set(liveDmsNewestFirst()));
    } catch (error) {
      console.error(`${time()}  DM read failed:`, error);
    }
  }
}

const noticesSince = () => {
  const since = Number(process.env["SLACK_NOTICES_SINCE"]);
  return since === 0 || Number.isNaN(since) ? undefined : since;
};

if (import.meta.main) {
  const me = await slackUserId();
  loadState();
  const isWatchingNotices = didStartWatchingNotices((notice) => {
    void handleNotice(notice, me);
  }, noticesSince());
  console.log(`slack sentry as ${me === "" ? "?" : me}, every ${INTERVAL_MS / 1000}s; notifications ${isWatchingNotices ? "watched" : "unreadable, polling only"}`);
  void readDmsForever(me);
  for (;;) {
    try {
      const targets = await tick(me);
      process.title = `slack sentry (${targets} targets)`;
    } catch (error) {
      console.error(`${time()}  tick failed:`, error);
    }
    await Bun.sleep(INTERVAL_MS);
  }
}
