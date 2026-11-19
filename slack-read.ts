import { mcp } from "./mcp";
import { isRecord } from "./shared/guards";
import { readStateJson, type SlackKept, slackMessagesTable, writeStateJson } from "./state";

const DOMAIN = process.env["SLACK_DOMAIN"] ?? "dryftai";

export type Msg = { ts: string; uid: string; who: string; text: string; channel?: string; link?: string; bot?: boolean; members?: string };
export type Kept = { at: number; title: string; msgs: Msg[] };
export type SlackReply = Record<string, unknown>;


export const replyField = (reply: SlackReply, key: string) => {
  const value = reply[key];
  return typeof value === "string" ? value : "";
};

function replyText(tool: string, out: string): unknown {
  const parsed: unknown = JSON.parse(out);
  const content = isRecord(parsed) ? parsed["content"] : undefined;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  if (!isRecord(first)) throw new TypeError(`${tool}: the connector's reply has no content`);
  return first["text"];
}

export async function slackCall(tool: string, args: Record<string, unknown>): Promise<SlackReply> {
  const { ok, out, err } = await mcp("claude.ai/slack", tool, args);
  if (!ok) throw new Error(`${tool}: ${(err || out).trim().slice(0, 300)}`);
  const text = replyText(tool, out);
  if (typeof text !== "string") return { raw: text };
  try {
    const reply: unknown = JSON.parse(text);
    return isRecord(reply) ? reply : {};
  } catch {
    return { raw: text };
  }
}

export const short = (text: string, n = 300) => (text.replaceAll(/\s+/g, " ").trim().slice(0, n) + (text.length > n ? "…" : "")).trim();
const withoutEmail = (name: string) => name.replace(/\s*<[^>]*>$/, "").trim();

const MESSAGE_HEADER =
  /(?:=== Message from (.*?) \((\w+)\) at [^\n]*?===|(?:=== THREAD PARENT MESSAGE ===|--- Reply \d+ of \d+ ---)\nFrom: (.*?) \((\w+)\)\nTime: [^\n]*)\s*\nMessage TS: ([\d.]+)\n/g;
const MESSAGE_FOOTERS = /\n(?:=== THREAD REPLIES[^\n]*|Thread: \d+ repl[^\n]*|Reactions: [^\n]*|Files: [^\n]*)/g;

function attachedFileNames(raw: string) {
  const filesLine = /\nFiles: ([^\n]*)/.exec(raw)?.[1] ?? "";
  return filesLine
    .matchAll(/([^,(]+?) \(ID: F\w+/g)
    .map((m) => (m[1] ?? "").trim())
    .toArray();
}

export function parseMessages(body: string): Msg[] {
  const heads = body.matchAll(MESSAGE_HEADER).toArray();
  return heads.map((head, i) => {
    const raw = body.slice(head.index + head[0].length, heads[i + 1]?.index ?? body.length);
    const text = `\n${raw}`.replaceAll(MESSAGE_FOOTERS, "").trim();
    const [, fromName, fromUid, replyName, replyUid, ts = ""] = head;
    const uid = fromUid ?? replyUid ?? "";
    const fileLines = attachedFileNames(raw).map((name) => `📎 ${name}`);
    return {
      ts,
      uid,
      who: withoutEmail(fromName ?? replyName ?? "") || uid,
      text: [text, ...fileLines].filter((part) => part !== "").join("\n"),
    };
  });
}

const SEARCH_HIT =
  /Channel: ([^\n(]+?) \(ID: (\w+)\)\n(?:Participants: ([^\n]*)\n)?[\s\S]*?From: (.*?) \(ID: (\w+)\)([^\n]*)\n[\s\S]*?Message_ts: ([\d.]+)\nPermalink: \[link\]\(([^)]+)\)\nText: \n([\s\S]*?)(?=\nContext before:|\n---|$)/g;
const CHANNEL_LABELS = new Map([
  ["DM", "a DM"],
  ["Group DM", "a group DM"],
]);

function searchHit([, channel = "", , participants, who = "", uid = "", authorTags = "", ts = "", link = "", text = ""]: RegExpExecArray): Msg {
  return {
    channel: CHANNEL_LABELS.get(channel) ?? channel,
    uid,
    who: withoutEmail(who),
    bot: authorTags.includes("[BOT]"),
    ts,
    link,
    text: text.trim(),
    ...(participants !== undefined && participants !== "" && { members: participants }),
  };
}

async function search(query: string): Promise<Msg[]> {
  const reply = await slackCall("slack_search_public_and_private", { query, sort: "timestamp", limit: 20 });
  return replyField(reply, "results").matchAll(SEARCH_HIT).map(searchHit).toArray();
}

export const permalink = (channel: string, ts: string, thread?: string) => {
  const isThreadReply = thread !== undefined && thread !== "" && thread !== ts;
  const threadQuery = isThreadReply ? `?thread_ts=${thread}&cid=${channel}` : "";
  return `https://${DOMAIN}.slack.com/archives/${channel}/p${ts.replace(".", "")}${threadQuery}`;
};

export function splitTarget(target: string) {
  const [channel = "", thread] = target.split("/", 2);
  return { channel, thread: thread === "" ? undefined : thread };
}

async function readConversation(channel: string, thread: string | undefined, oldest: string | undefined) {
  const since = oldest === "" ? undefined : oldest;
  const reply =
    thread === undefined
      ? await slackCall("slack_read_channel", { channel_id: channel, limit: 50, ...(since !== undefined && { oldest: since }) })
      : await slackCall("slack_read_thread", { channel_id: channel, message_ts: thread, ...(since === undefined ? { limit: 1000 } : { oldest: since }) });
  return replyField(reply, "messages") || replyField(reply, "raw");
}

export async function read(target: string, oldest?: string): Promise<{ msgs: Msg[]; title: string; name: string }> {
  if (target.startsWith("search:")) {
    const query = `search "${short(target.slice(7), 60)}"`;
    return { msgs: (await search(target.slice(7))).toReversed(), title: query, name: query };
  }
  const { channel, thread } = splitTarget(target);
  const body = await readConversation(channel, thread, oldest);
  const msgs = parseMessages(body).toSorted((a, b) => Number(a.ts) - Number(b.ts));
  const name = /^Channel: (#\S+)/.exec(body)?.[1] ?? channel;
  if (thread === undefined) return { msgs, title: name, name };
  const parent = msgs.find((m) => m.ts === thread);
  return { msgs, title: `thread ${parent ? `"${short(parent.text, 60)}"` : thread} in ${name}`, name };
}

const CHANNEL_NAME_HIT = /Name: #([\w.-]+)\n[\s\S]*?archives\/([A-Z0-9]+)/g;
export async function channelIdByName(name: string, limit: number) {
  const reply = await slackCall("slack_search_channels", { keywords: [name], channel_types: "public_channel,private_channel", limit });
  return replyField(reply, "results")
    .matchAll(CHANNEL_NAME_HIT)
    .find((m) => m[1] === name)?.[2];
}

const ARCHIVE_LINK = /archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?(?:.*thread_ts=([\d.]+))?/;
function targetOfArchiveLink([, channel = "", seconds, micros = "", threadTs]: RegExpExecArray) {
  if (threadTs !== undefined && threadTs !== "") return `${channel}/${threadTs}`;
  if (seconds !== undefined && seconds !== "") return `${channel}/${seconds}.${micros}`;
  return channel;
}

export async function parseTarget(ref: string) {
  const link = ARCHIVE_LINK.exec(ref);
  if (link) return targetOfArchiveLink(link);
  if (/^[CDG][A-Z0-9]{8,}(\/[\d.]+)?$/.test(ref)) return ref;
  if (ref.startsWith("#")) return (await channelIdByName(ref.slice(1), 10)) ?? null;
  return `search:${ref.replace(/^search:/, "")}`;
}

const asMsg = (stored: SlackKept["msgs"][number]): Msg => ("members" in stored && typeof stored.members === "string" ? { ...stored, members: stored.members } : stored);

export function readMessages(): Record<string, Kept> {
  return Object.fromEntries(Object.entries(slackMessagesTable.all()).map(([target, kept]) => [target, { at: kept.at ?? 0, title: kept.title, msgs: kept.msgs.map(asMsg) }]));
}

export type Watch = { target: string; sessions: string[] };
const WATCH_FILE = "slack-watch.json";
const isWatch = (value: unknown): value is Watch => isRecord(value) && typeof value["target"] === "string" && Array.isArray(value["sessions"]);
const isWatchList = (value: unknown): value is Watch[] => Array.isArray(value) && value.every(isWatch);
export const readWatches = (): Watch[] => readStateJson(WATCH_FILE, isWatchList) ?? [];
export const writeWatches = (watches: Watch[]) => {
  writeStateJson(WATCH_FILE, watches);
};
