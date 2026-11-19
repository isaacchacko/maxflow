#!/usr/bin/env bun
import { BASE as base } from "../instance";
import { isRecord } from "../shared/guards";
import { readStateJson, readStateText, writeStateJson } from "../state";
import { FETCH_MS, log, run, stringField } from "./inbox-board";
import { flushBatch, remember } from "./inbox-feed";
import { refreshPrs } from "./inbox-github";
import { type LocalFiles, onPrEvent } from "./inbox-pr-events";
import { closeHandledReplies, conversationKey, onSlack, readable, slackEventOf, slackOut } from "./inbox-slack";
import { state } from "./inbox-state";
import { raiseStalls } from "./inbox-stalls";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("inbox");

const STATE_FILE = "inbox-state.json";
const PRS_MS = Number(process.env["INBOX_PRS_MS"] ?? 5 * 60_000);
const STALL_MS = Number(process.env["INBOX_STALL_MS"] ?? 15 * 60_000);
const BATCH_DEBOUNCE_MS = Number(process.env["INBOX_BATCH_MS"] ?? 10_000);
const HANDLED_MS = Number(process.env["INBOX_HANDLED_MS"] ?? 2 * 60_000);
const IDLE_POLL_MS = 60_000;
const DAY_MS = 86_400_000;
const REMEMBERED_TOPIC = /^slack\/(dm|mention|own|\w+\/[\d.]+\/reply)$/;

type BusEvent = { seq: number; topic: string; data: unknown };
const isBusEvent = (value: unknown): value is BusEvent => isRecord(value) && typeof value["seq"] === "number" && typeof value["topic"] === "string";
const clock = { handledAt: 0 };

function carryOverFeedThreadsByTask(feedThreadByTask: Record<string, unknown>) {
  for (const [key, task] of Object.entries(state.tasks)) {
    const thread = feedThreadByTask[String(task)];
    if (typeof thread === "string" && thread !== "") state.feedThreads[key] ??= thread;
  }
}

function loadState() {
  const saved = readStateJson(STATE_FILE);
  if (!isRecord(saved)) return;
  const { fed, ...rest } = saved;
  Object.assign(state, rest);
  if (isRecord(fed)) carryOverFeedThreadsByTask(fed);
}

const localFiles: LocalFiles = {
  ownPrs: () => {
    const queue = readStateJson("review-queue.json");
    const prs = Array.isArray(queue) ? queue.map((q: unknown) => (isRecord(q) ? q["pr"] : undefined)).filter((pr) => typeof pr === "string") : [];
    return new Set(prs);
  },
  flakyChecks: () => {
    const patterns = readStateJson("flaky-checks.json");
    return Array.isArray(patterns) ? patterns.filter((p) => typeof p === "string").map((p) => new RegExp(p, "i")) : [];
  },
};

function loggedEvent(line: string): Record<string, unknown> | undefined {
  if (!line.includes('"topic":"slack/')) return;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rememberLoggedSlackEvent(line: string, me: string) {
  const entry = loggedEvent(line);
  if (!entry) return;
  const topic = stringField(entry, "topic") ?? "";
  const at = entry["at"];
  const event = slackEventOf(entry["data"]);
  if ((typeof at === "number" && Date.now() - at > DAY_MS) || !event || (event.text ?? "") === "" || event.isBot || !REMEMBERED_TOPIC.test(topic)) return;
  const mine = topic === "slack/own" || event.user === me;
  remember(conversationKey(event.link, event.thread), { at: Number(event.ts) * 1000, who: event.from ?? "?", text: readable(event.text), mine, user: event.user, raw: event.text, link: event.link });
}

function seedConversationsFromBusLog(me: string) {
  if (Object.keys(state.convo).length > 0) return;
  for (const line of (readStateText("events.jsonl") ?? "").split("\n")) rememberLoggedSlackEvent(line, me);
}

function watchReplyTasksOpenedBeforeReactions() {
  const watched = new Set(Object.values(state.open));
  for (const [key, id] of Object.entries(state.tasks)) {
    const ts = key.split("/", 2)[1];
    if (ts !== undefined && /^[CDG]\w+\/[\d.]+$/.test(key) && !watched.has(key) && id !== 0) state.open[ts] = key;
  }
}

async function isServerUp() {
  try {
    return (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(FETCH_MS) })).ok;
  } catch {
    return false;
  }
}

async function currentSeq() {
  const res = await fetch(`${base}/api/events?topic=none&after=now`, { signal: AbortSignal.timeout(FETCH_MS) });
  return Number(res.headers.get("x-maxflow-seq") ?? 0);
}

async function nextEvents() {
  const wait = state.batch.length > 0 ? Math.max(1_000, state.batchAt + BATCH_DEBOUNCE_MS - Date.now()) : IDLE_POLL_MS;
  const res = await fetch(`${base}/api/events?topic=**&after=${state.seq}&wait=${wait}`, { signal: AbortSignal.timeout(wait + FETCH_MS) });
  const events: unknown = await res.json();
  return Array.isArray(events) ? events.filter(isBusEvent) : [];
}

async function runDueJobs(me: string, ghMe: string) {
  if (Date.now() - clock.handledAt >= HANDLED_MS) {
    await closeHandledReplies(me);
    clock.handledAt = Date.now();
  }
  if (Date.now() - state.prsAt >= PRS_MS) await refreshPrs(ghMe);
  if (Date.now() - state.stallAt >= STALL_MS) await raiseStalls();
}

async function step(me: string, ghMe: string) {
  await runDueJobs(me, ghMe);
  for (const event of await nextEvents()) {
    state.seq = event.seq;
    if (event.topic.startsWith("slack/")) await onSlack(event.topic, event.data, me);
    else if (event.topic.startsWith("gh/")) await onPrEvent(event.topic, event.data, localFiles);
  }
  if (state.batch.length > 0) {
    if (state.batchAt === 0) state.batchAt = Date.now();
    if (Date.now() - state.batchAt >= BATCH_DEBOUNCE_MS) await flushBatch();
  }
  writeStateJson(STATE_FILE, state);
}

loadState();

if (import.meta.main) {
  const ghMe = run(["gh", "api", "user", "-q", ".login"]);
  const me = /User ID: (\w+)/.exec(slackOut("slack_read_user_profile", {}))?.[1] ?? "";
  while (!(await isServerUp())) await Bun.sleep(2_000);
  if (state.seq === 0) state.seq = await currentSeq();
  log(`inbox sentry as ${ghMe || "?"} / ${me || "?"}`);
  seedConversationsFromBusLog(me);
  watchReplyTasksOpenedBeforeReactions();
  for (;;) {
    try {
      await step(me, ghMe);
    } catch (error) {
      log(`tick failed: ${String(error)}`);
      await Bun.sleep(10_000);
    }
  }
}
