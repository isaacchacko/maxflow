import { homedir } from "node:os";
import { join } from "node:path";
import { BASE as base } from "../instance";
import { mcpSync } from "../mcp";
import { splitTarget } from "../slack-read";
import { isRecord } from "../shared/guards";
import { closeTask, getTasks, isOpen, log, onBoard, post, run, shortened, stringField, type Task } from "./inbox-board";
import { feed, remember } from "./inbox-feed";
import { isBareAck, noteFyi } from "./inbox-fyi";
import { slackNamesById, state } from "./inbox-state";
import { fetchSessions, isSession } from "./slack-sessions";

const PROJECTS = join(homedir(), ".claude", "projects");
const CLI = new URL("../cli.ts", import.meta.url).pathname;
const ALERT_NOTE_MS = 3_600_000;
const REVIVE_MS = 60_000;

export type SlackEvent = {
  link: string;
  ts: string;
  from: string | undefined;
  text: string | undefined;
  user: string | undefined;
  where: string | undefined;
  thread: string | undefined;
  isToldToSession: boolean;
  isByAgent: boolean;
  isBot: boolean;
};
type Kind = "mention" | "dm" | "reply";
type Incoming = { key: string; kind: Kind; text: string; me: string };

export function slackEventOf(data: unknown): SlackEvent | undefined {
  if (!isRecord(data)) return;
  const link = stringField(data, "link");
  const ts = stringField(data, "ts");
  if (link === undefined || link === "" || ts === undefined) return;
  const told = data["told"];
  return {
    link,
    ts,
    from: stringField(data, "from"),
    text: stringField(data, "text"),
    user: stringField(data, "user"),
    where: stringField(data, "where"),
    thread: stringField(data, "thread"),
    isToldToSession: Array.isArray(told) && told.length > 0,
    isByAgent: data["agent"] === true,
    isBot: data["bot"] === true,
  };
}

export const slackOut = (tool: string, args: Record<string, unknown>) => {
  const result = mcpSync("claude.ai/slack", tool, args);
  return result.ok ? result.out.trim() : "";
};

export function conversationKey(link: string, thread: string | undefined) {
  const match = /archives\/(\w+)\/p\d+(\?thread_ts=)?/.exec(link);
  const channel = match?.[1];
  return channel?.startsWith("D") === true && match?.[2] === undefined ? channel : (thread ?? channel ?? link);
}

const slackLink = (target: string) => {
  const { channel, thread } = splitTarget(target);
  return `https://dryftai.slack.com/archives/${channel}${thread === undefined ? "" : `/p${thread.replace(".", "")}`}`;
};

function mentionLabel(id: string, name: string | undefined) {
  if (name !== undefined && name !== "") return name;
  const known = slackNamesById[id];
  return known === undefined || known === "" ? id : known;
}

export const readable = (text = "") =>
  text
    .replaceAll(/<@(\w+)(?:\|([^>]*))?>/g, (_match, id: string, name: string | undefined) => `@${mentionLabel(id, name)}`)
    .replaceAll(/<#\w+(?:\|([^>]*))?>/g, (_match, name = "channel") => `#${String(name)}`)
    .replaceAll(/<!(\w+)(?:\|[^>]*)?>/g, "@$1")
    .replaceAll(/<([^|>]+)\|([^>]*)>/g, "$2")
    .replaceAll(/<([^>]+)>/g, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

function chatThatPosted(ts: string) {
  const out = run(["rg", "-l", "--max-count", "1", "--glob", "*.jsonl", `slack_send_message.*${ts.replace(".", String.raw`\.`)}`, PROJECTS]);
  const files = out.split("\n").filter((f) => f !== "" && !f.includes("/subagents/"));
  const newest = files.map((f) => ({ f, at: Bun.file(f).lastModified })).toSorted((a, b) => b.at - a.at)[0];
  return newest === undefined ? undefined : /([\w-]+)\.jsonl$/.exec(newest.f)?.[1];
}

async function runningChat(chat: string) {
  const sessions = await fetchSessions();
  return sessions.find((s) => s.running && (s.chatId === chat || s.transcript?.endsWith(`${chat}.jsonl`) === true));
}

async function revive(chat: string) {
  const res = await fetch(`${base}/api/chats/${chat}/resume`, { method: "POST", body: JSON.stringify({ bypass: true }), signal: AbortSignal.timeout(REVIVE_MS) });
  if (!res.ok) {
    log(`revive ${chat} failed: ${await res.text()}`);
    return;
  }
  const revived: unknown = await res.json();
  return isSession(revived) ? revived : undefined;
}

async function handToChatThatPosted(key: string, line: string) {
  const ts = key.split("/", 2)[1];
  if (ts === undefined || ts === "") return null;
  const chat = chatThatPosted(ts);
  if (chat === undefined || chat === "") return null;
  const session = (await runningChat(chat)) ?? (await revive(chat));
  if (!session) return null;
  run([CLI, "slack", "watch", key, "--session", session.id]);
  await post(`/api/sessions/${session.id}/notify`, {
    text: `[yarn inbox] A new message in a Slack thread you posted in, which no session was watching: ${line} Whole thread: ${CLI} slack read ${key}. It's on the user's board; act on it if it's yours to answer or fix, and never post as him without his say-so.`,
  });
  return session.id;
}

function hasReacted(channel: string, ts: string, me: string) {
  const out = slackOut("slack_get_reactions", { channel_id: channel, message_ts: ts });
  return me !== "" && out.includes(`(${me})`);
}

async function onBotAlert(event: SlackEvent, text: string) {
  const raw = String(event.text);
  const tag = `bot:${String(event.user)}:${shortened(raw.replaceAll(/<[^>]*>/g, "").replaceAll(/\d+/g, "#"), 120)}`;
  const alert = (state.alerts[tag] ??= { count: 0, noted: 0 });
  alert.count += 1;
  const isAlreadyOpen = isOpen((await getTasks()).find((t) => t.id === state.tasks[tag]));
  if (isAlreadyOpen && Date.now() - alert.noted < ALERT_NOTE_MS) return;
  const where = (event.where ?? "Slack").replace(/^thread .* in /, "");
  const url = /<(https?:[^|>]+)/.exec(raw)?.[1];
  const who = event.from ?? "?";
  const note = isAlreadyOpen ? `${alert.count} more since the last note, latest ${url ?? event.link}` : `${who} in ${where}: "${shortened(text, 120)}" ${url ?? ""}`;
  await onBoard(tag, event.link, note, { title: `${who} alert: "${shortened(text.replaceAll(/\d+/g, "#"), 60)}"`, status: "you" });
  Object.assign(alert, { count: 0, noted: Date.now() });
}

// constraint: a bot's bare "cc" (the Arch bot copying him into a thread in #arch_comms) asks nothing of him; Isaac said to ignore it.
const isBareCc = (raw: string | undefined) => /^cc[.!]?$/i.test(String(raw).replaceAll(/<[^>]*>/g, "").trim());

function placeName(event: SlackEvent, kind: Kind) {
  if (kind === "dm") return "a DM";
  const where = (event.where ?? "").replace(/^thread .* in /, "");
  return where === "" ? "Slack" : where;
}

async function putReplyOnBoard(event: SlackEvent, incoming: Incoming, where: string, owner: string | null) {
  const { key, kind, text } = incoming;
  const who = event.from ?? "?";
  const handedTo = owner === null ? "" : `; handed to ${owner}, the chat that posted there`;
  const note = `${who}${kind === "dm" ? " (DM)" : ""}: "${shortened(text, 120)}"${handedTo}`;
  const link = key.startsWith("http") ? key : slackLink(key);
  return onBoard(key, link, note, { title: `Reply to ${who} in ${where}: "${shortened(text, 50)}"`, status: "you" });
}

async function boardUnlessAck(event: SlackEvent, incoming: Incoming, where: string, owner: string | null) {
  if (owner !== null || !isBareAck(event.text)) return putReplyOnBoard(event, incoming, where, owner);
  await noteFyi(`${event.from ?? "?"} in ${where}: "${incoming.text}"`, event.link);
  return null;
}

async function onPersonMessage(event: SlackEvent, incoming: Incoming) {
  const { key, kind, text, me } = incoming;
  const who = event.from ?? "?";
  const where = placeName(event, kind);
  const owner = kind === "dm" ? null : await handToChatThatPosted(key, `${who} in ${where}: "${shortened(text, 200)}" ${event.link}`);
  if (!key.startsWith("http") && hasReacted(key.split("/", 1)[0] ?? "", event.ts, me)) {
    log(`skipped ${event.link}: the user already reacted`);
    return;
  }
  const task = await boardUnlessAck(event, incoming, where, owner);
  if (task !== null) state.open[event.ts] = key;
  if (text.includes("?")) state.questions[event.ts] = { key, at: Date.now(), who, text, link: event.link };
  if (owner !== null || task === null || kind === "reply") return;
  feed({ task, key, source: "slack", who, where, text: shortened(text, 500), link: event.link, at: Number(event.ts) * 1000, user: event.user, raw: event.text });
}

function kindOf(topic: string): Kind | null {
  if (topic === "slack/mention") return "mention";
  if (topic === "slack/dm") return "dm";
  return /^slack\/\w+\/[\d.]+\/reply$/.test(topic) ? "reply" : null;
}

function learnName(event: SlackEvent) {
  const { user, from } = event;
  if (user !== undefined && user !== "" && from !== undefined && from !== "") slackNamesById[user] = from;
}

const isLeftToSessions = (event: SlackEvent, kind: Kind) => event.isToldToSession || event.isByAgent || (kind !== "mention" && event.isBot);

export async function onSlack(topic: string, data: unknown, me: string) {
  const event = slackEventOf(data);
  if (!event || state.seen.includes(event.ts)) return;
  const key = conversationKey(event.link, event.thread);
  learnName(event);
  const text = readable(event.text);
  const isHis = topic === "slack/own" || event.user === me;
  remember(key, { at: Number(event.ts) * 1000, who: event.from ?? "?", text, mine: isHis, user: event.user, raw: event.text, link: event.link });
  if (isHis) {
    state.answered[key] = Math.max(state.answered[key] ?? 0, Number(event.ts));
    return;
  }
  const kind = kindOf(topic);
  if (kind === null || isLeftToSessions(event, kind)) return;
  state.seen = [...state.seen, event.ts].slice(-1000);
  if (event.isBot && isBareCc(event.text)) log(`skipped ${event.link}: a bot's bare cc`);
  else if (event.isBot) await onBotAlert(event, text);
  else await onPersonMessage(event, { key, kind, text, me });
}

const forgetOpenReplies = (stamps: string[]) => {
  state.open = Object.fromEntries(Object.entries(state.open).filter(([ts]) => !stamps.includes(ts)));
};

async function closeIfHandled(key: string, stamps: string[], tasks: Task[], me: string) {
  if (!isOpen(tasks.find((t) => t.id === state.tasks[key]))) {
    forgetOpenReplies(stamps);
    return;
  }
  const isReplied = stamps.some((ts) => (state.answered[key] ?? 0) > Number(ts));
  const isReacted = !isReplied && stamps.some((ts) => hasReacted(key.split("/", 1)[0] ?? "", ts, me));
  if (!isReplied && !isReacted) return;
  await closeTask(key, isReplied ? "you replied in the thread" : "you reacted to the message");
  forgetOpenReplies(stamps);
  state.questions = Object.fromEntries(Object.entries(state.questions).filter(([, q]) => q.key !== key));
  log(`closed ${key}: ${isReplied ? "replied" : "reacted"}`);
}

export async function closeHandledReplies(me: string) {
  const byKey = new Map<string, string[]>();
  for (const [ts, key] of Object.entries(state.open)) byKey.set(key, [...(byKey.get(key) ?? []), ts]);
  const tasks = await getTasks();
  for (const [key, stamps] of byKey) await closeIfHandled(key, stamps, tasks, me);
}
