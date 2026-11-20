#!/usr/bin/env bun
import { yarnEnv, seqOf } from "../shared/legacy-maxflow";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE as base } from "../instance";
import { mcpSync } from "../mcp";
import { isRecord, stringOr } from "../shared/guards";
import { dmPartnersByChannel } from "../slack-meta";
import { readStateJson, readStateText, slackMessagesTable, stateDirectory, writeStateJson } from "../state";
import { isStillTheFeed, replaceOlderFeed, waitForServer } from "./feed-process";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("context");

const STATE_FILE = "context-state.json";
const DIGEST_FILE = join(stateDirectory("."), "context-digest.md");
const FLUSH_MS = Number(process.env["CONTEXT_FLUSH_MS"] ?? 2 * 60_000);
const SWEEP_MS = Number(process.env["CONTEXT_SWEEP_MS"] ?? 30 * 60_000);
const BACKFILL_MS = 86_400_000;
const SWEEP_OVERLAP_MS = 5 * 60_000;
const NOTIFY_CHARS = 8000;
const SEEN_KEPT = 5000;
const FETCH_MS = 30_000;
const IDLE_WAIT_MS = 60_000;
const MIN_WAIT_MS = 1000;
const AGENT_STARTUP_MS = 20_000;
const RETRY_MS = 10_000;
const SLACK_TOPICS = /^slack\/(dm|mention|own|search|\w+\/message|\w+\/[\d.]+\/reply)$/;

type Item = { key: string; where: string; link: string; at: number; who: string; mine: boolean; text: string; swept?: boolean };
type State = { seq: number; seen: string[]; pending: Item[]; firstAt: number; sweptAt: number; started?: boolean };
type BusEvent = { seq: number; topic: string; data: unknown };
const isPartialState = (value: unknown): value is Partial<State> => isRecord(value);
const isBusEvent = (value: unknown): value is BusEvent => isRecord(value) && typeof value["seq"] === "number" && typeof value["topic"] === "string";

const kept = readStateJson(STATE_FILE, isPartialState);
const state: State = { seq: 0, seen: [], pending: [], firstAt: 0, sweptAt: 0, ...kept };
const save = () => {
  writeStateJson(STATE_FILE, state);
};
const caller = { "x-yarn-from": yarnEnv("SESSION") ?? "" };
const log = (line: string) => {
  console.log(`${new Date().toLocaleTimeString()}  ${line}`);
};
const notify = async (text: string) =>
  fetch(`${base}/api/sessions/${String(yarnEnv("SESSION"))}/notify`, {
    method: "POST",
    headers: caller,
    body: JSON.stringify({ text: `[yarn context] ${text}` }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
const short = (text: string, n: number) => {
  const t = text.replaceAll(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};
const slackMarkupAsReaderSeesIt = (text: unknown) =>
  stringOr(text)
    .replaceAll(/<@\w+\|([^>]*)>/g, "@$1")
    .replaceAll(/<#\w+(?:\|([^>]*))?>/g, (_match, name = "channel") => `#${String(name)}`)
    .replaceAll(/<([^|>]+)\|([^>]*)>/g, "$2")
    .replaceAll(/<([^>]+)>/g, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

function dmByChannelElseThreadElseChannel(link: string) {
  const m = /archives\/(\w+)\/p(\d{10})(\d{6})(\?thread_ts=([\d.]+))?/.exec(link);
  if (m === null) return link;
  const [, channel = "", seconds = "", micros = "", threadQuery, thread] = m;
  return threadQuery === undefined && channel.startsWith("D") ? channel : `${channel}/${thread ?? `${seconds}.${micros}`}`;
}

function add(i: Item, ts: string) {
  if (i.text.trim() === "" || state.seen.includes(ts)) return;
  state.seen = [...state.seen, ts].slice(-SEEN_KEPT);
  state.pending.push(i);
  if (state.firstAt === 0) state.firstAt = Date.now();
}

function onEvent(topic: string, data: unknown, me: string) {
  const d = isRecord(data) ? data : {};
  const link = stringOr(d["link"]);
  const ts = stringOr(d["ts"]);
  if (link === "" || ts === "" || !SLACK_TOPICS.test(topic) || Boolean(d["bot"])) return;
  const where = topic === "slack/dm" ? `DM with ${String(d["from"])}` : stringOr(d["where"], "Slack");
  const who = stringOr(d["from"], "?");
  add({ key: dmByChannelElseThreadElseChannel(link), where, link, at: Number(ts) * 1000, who, mine: topic === "slack/own" || d["user"] === me, text: slackMarkupAsReaderSeesIt(d["text"]) }, ts);
}

function sweepWhatNoEventCarried(me: string, since: number) {
  const before = state.pending.length;
  const dms = dmPartnersByChannel();
  const conversations = Object.entries(slackMessagesTable.all()).filter(([target]) => !target.startsWith("search:"));
  for (const [target, { title, msgs }] of conversations) {
    const [channel = "", thread = ""] = target.split("/", 2);
    const recent = msgs.filter((msg) => msg.bot !== true && Number(msg.ts) * 1000 >= since);
    for (const m of recent) {
      const link = m.link ?? `https://dryftai.slack.com/archives/${channel}/p${m.ts.replace(".", "")}${thread === "" ? "" : `?thread_ts=${thread}&cid=${channel}`}`;
      const where = thread === "" && channel.startsWith("D") ? `DM with ${stringOr(dms[channel], channel)}` : title;
      add({ key: target, where, link, at: Number(m.ts) * 1000, who: m.who, mine: m.uid === me, text: slackMarkupAsReaderSeesIt(m.text), swept: true }, m.ts);
    }
  }
  return state.pending.length - before;
}

function digestBody() {
  const groups = Map.groupBy(state.pending.toSorted((a, b) => a.at - b.at), (i) => i.key);
  const sections = groups.values().map((items) => {
    const lines = items.map((i) => `- ${new Date(i.at).toISOString().slice(5, 16).replace("T", " ")}Z ${i.mine ? "Isaac (him)" : i.who}: ${short(i.text, 600)}${i.swept === true ? " (read by the slack sentry)" : ""}`);
    const [first] = items;
    return first === undefined ? "" : `### ${first.where} (${first.key}) ${first.link}\n${lines.join("\n")}`;
  }).toArray();
  return { body: sections.join("\n\n"), conversations: groups.size };
}

async function flush(isFirst: boolean) {
  const { body, conversations } = digestBody();
  const count = state.pending.length;
  const head = isFirst
    ? `First notice: the last day of his Slack, ${count} messages. Build $YARN_STATE/context.md from it.`
    : `${count} new Slack message${count > 1 ? "s" : ""}. Update $YARN_STATE/context.md.`;
  writeFileSync(DIGEST_FILE, `${head}\n\n${body}\n`);
  const text = body.length > NOTIFY_CHARS ? `${head} The whole digest is in ${DIGEST_FILE}; it starts:\n\n${body.slice(0, NOTIFY_CHARS)}…` : `${head}\n\n${body}`;
  const res = await notify(text);
  if (!res.ok) {
    log(`notify failed: ${await res.text()}`);
    return;
  }
  log(`handed ${count} messages in ${conversations} conversations`);
  state.pending = [];
  state.firstAt = 0;
}

function replaySlackEventsOfLastDay(me: string) {
  const lines = (readStateText("events.jsonl") ?? "").split("\n").filter((line) => line.includes('"topic":"slack/'));
  for (const line of lines) {
    try {
      const e: unknown = JSON.parse(line);
      if (isRecord(e) && Date.now() - Number(e["at"]) < BACKFILL_MS) onEvent(stringOr(e["topic"]), e["data"], me);
    } catch {
      continue;
    }
  }
}

async function firstNoticeReachingBackADay(me: string) {
  const res = await fetch(`${base}/api/events?topic=none&after=now`, { signal: AbortSignal.timeout(FETCH_MS) });
  state.seq = Number(seqOf(res) ?? 0);
  replaySlackEventsOfLastDay(me);
  sweepWhatNoEventCarried(me, Date.now() - BACKFILL_MS);
  state.sweptAt = Date.now();
  await Bun.sleep(AGENT_STARTUP_MS);
  await flush(true);
  state.started = true;
  save();
}

async function tickFeed(me: string) {
  const wait = state.pending.length > 0 ? Math.max(MIN_WAIT_MS, state.firstAt + FLUSH_MS - Date.now()) : IDLE_WAIT_MS;
  const res = await fetch(`${base}/api/events?topic=slack/**&after=${state.seq}&wait=${wait}`, { signal: AbortSignal.timeout(wait + FETCH_MS) });
  const events: unknown = await res.json();
  const busEvents = Array.isArray(events) ? events.filter(isBusEvent) : [];
  for (const e of busEvents) {
    state.seq = e.seq;
    onEvent(e.topic, e.data, me);
  }
  if (Date.now() - state.sweptAt >= SWEEP_MS) {
    const n = sweepWhatNoEventCarried(me, state.sweptAt - SWEEP_OVERLAP_MS);
    if (n > 0) log(`sweep found ${n} messages no event carried`);
    state.sweptAt = Date.now();
  }
  if (state.pending.length > 0 && Date.now() - state.firstAt >= FLUSH_MS) await flush(false);
  save();
}

async function runFeed() {
  replaceOlderFeed("context");
  const profile = mcpSync("claude.ai/slack", "slack_read_user_profile", {}).out;
  const me = /User ID: (\w+)/.exec(profile)?.[1] ?? "";
  await waitForServer();
  log(`context feed as ${me === "" ? "?" : me}`);
  if (state.started !== true) await firstNoticeReachingBackADay(me);
  for (;;) {
    try {
      await tickFeed(me);
    } catch (error) {
      log(`tick failed: ${String(error)}`);
      await Bun.sleep(RETRY_MS);
    }
    if (!isStillTheFeed("context")) process.exit(0);
  }
}

if (import.meta.main) await runFeed();
