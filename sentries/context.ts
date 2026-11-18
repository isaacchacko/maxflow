#!/usr/bin/env bun
// context sentry's feed: runs beside the context agent (sentries/context.md) in its pane. It hands the agent every Slack message the
// sentries publish (DMs to the user, mentions of him, his own posts, replies in threads and posts in channels someone watches), grouped
// by conversation, within FLUSH_MS of the first, and every SWEEP_MS what the slack sentry read into its store that no event carried (both
// sides of his DMs, the threads he posts in). Its first notice reaches back a day. Exits with the agent.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE as base, STATE_DIR } from "../instance";

const STATE_FILE = join(STATE_DIR, "context-state.json");
const DIGEST_FILE = join(STATE_DIR, "context-digest.md");
const MESSAGES_FILE = join(STATE_DIR, "slack-messages.json");
const FLUSH_MS = Number(process.env.CONTEXT_FLUSH_MS ?? 2 * 60_000);
const SWEEP_MS = Number(process.env.CONTEXT_SWEEP_MS ?? 30 * 60_000);
const BACKFILL_MS = 86_400_000;
const NOTIFY_CHARS = 8_000;

type Item = { key: string; where: string; link: string; at: number; who: string; mine: boolean; text: string; swept?: boolean };
type State = { seq: number; seen: string[]; pending: Item[]; firstAt: number; sweptAt: number; started?: boolean };
const state: State = { seq: 0, seen: [], pending: [], firstAt: 0, sweptAt: 0, ...(existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}) };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state));
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };
const log = (line: string) => console.log(`${new Date().toLocaleTimeString()}  ${line}`);
const notify = (text: string) =>
  fetch(`${base}/api/sessions/${process.env.MAXFLOW_SESSION}/notify`, { method: "POST", headers: caller, body: JSON.stringify({ text: `[maxflow context] ${text}` }) });
const short = (text: string, n: number) => { const t = text.replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n)}…`; };
// Slack's markup as a reader sees it.
const readable = (text: unknown) => String(text ?? "")
  .replace(/<@\w+\|([^>]*)>/g, "@$1")
  .replace(/<#\w+(?:\|([^>]*))?>/g, (_, name) => `#${name ?? "channel"}`)
  .replace(/<([^|>]+)\|([^>]*)>/g, "$2")
  .replace(/<([^>]+)>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// A DM is one conversation, keyed by its channel; anything else by its thread, or its channel for a top-level post.
function keyOf(link: string) {
  const m = link.match(/archives\/(\w+)\/p(\d{10})(\d{6})(\?thread_ts=([\d.]+))?/);
  if (!m) return link;
  return m[1].startsWith("D") && !m[4] ? m[1] : `${m[1]}/${m[5] ?? `${m[2]}.${m[3]}`}`;
}
const SLACK_TOPICS = /^slack\/(dm|mention|own|search|\w+\/message|\w+\/[\d.]+\/reply)$/;

function add(i: Item, ts: string) {
  if (state.seen.includes(ts) || !i.text.trim()) return;
  state.seen = [...state.seen, ts].slice(-5_000);
  state.pending.push(i);
  state.firstAt ||= Date.now();
}

function onEvent(topic: string, d: any, me: string) {
  if (!SLACK_TOPICS.test(topic) || !d?.link || !d.ts || d.bot) return;
  const where = topic === "slack/dm" ? `DM with ${d.from}` : String(d.where ?? "Slack");
  add({ key: keyOf(d.link), where, link: d.link, at: Number(d.ts) * 1000, who: d.from ?? "?", mine: topic === "slack/own" || d.user === me, text: readable(d.text) }, d.ts);
}

// What the slack sentry read into its store since the last sweep that no event carried: chiefly his side of his DMs and threads.
function sweep(me: string, since: number) {
  if (!existsSync(MESSAGES_FILE)) return 0;
  const before = state.pending.length;
  const store = JSON.parse(readFileSync(MESSAGES_FILE, "utf8")) as Record<string, { title: string; msgs: { ts: string; uid: string; who: string; text: string; link?: string; bot?: boolean }[] }>;
  const dms = existsSync(join(STATE_DIR, "slack-state.json")) ? JSON.parse(readFileSync(join(STATE_DIR, "slack-state.json"), "utf8")).dms ?? {} : {};
  for (const [target, { title, msgs }] of Object.entries(store)) {
    // Searches repeat what the events carried, out of their conversations.
    if (target.startsWith("search:")) continue;
    for (const m of msgs) {
      if (m.bot || Number(m.ts) * 1000 < since) continue;
      const [channel, thread] = target.split("/");
      const link = m.link ?? `https://dryftai.slack.com/archives/${channel}/p${m.ts.replace(".", "")}${thread ? `?thread_ts=${thread}&cid=${channel}` : ""}`;
      const where = channel.startsWith("D") && !thread ? `DM with ${dms[channel]?.who ?? channel}` : title;
      add({ key: target, where, link, at: Number(m.ts) * 1000, who: m.who, mine: m.uid === me, text: readable(m.text), swept: true }, m.ts);
    }
  }
  return state.pending.length - before;
}

async function flush(first: boolean) {
  const groups = new Map<string, Item[]>();
  for (const i of state.pending.toSorted((a, b) => a.at - b.at)) groups.set(i.key, [...(groups.get(i.key) ?? []), i]);
  const body = [...groups.values()].map((items) => {
    const lines = items.map((i) => `- ${new Date(i.at).toISOString().slice(5, 16).replace("T", " ")}Z ${i.mine ? "Isaac (him)" : i.who}: ${short(i.text, 600)}${i.swept ? " (read by the slack sentry)" : ""}`);
    return `### ${items[0].where} (${items[0].key}) ${items[0].link}\n${lines.join("\n")}`;
  }).join("\n\n");
  const head = first
    ? `First notice: the last day of his Slack, ${state.pending.length} messages. Build $MAXFLOW_STATE/context.md from it.`
    : `${state.pending.length} new Slack message${state.pending.length > 1 ? "s" : ""}. Update $MAXFLOW_STATE/context.md.`;
  writeFileSync(DIGEST_FILE, `${head}\n\n${body}\n`);
  const text = body.length > NOTIFY_CHARS ? `${head} The whole digest is in ${DIGEST_FILE}; it starts:\n\n${body.slice(0, NOTIFY_CHARS)}…` : `${head}\n\n${body}`;
  const res = await notify(text);
  if (!res.ok) return log(`notify failed: ${await res.text()}`);
  log(`handed ${state.pending.length} messages in ${groups.size} conversations`);
  state.pending = [];
  state.firstAt = 0;
}

if (import.meta.main) {
  const PID_FILE = join(STATE_DIR, "context-feed.pid");
  try {
    const old = readFileSync(PID_FILE, "utf8").trim();
    if (Bun.spawnSync(["ps", "-p", old, "-o", "command="]).stdout.toString().includes("sentries/context.ts")) process.kill(Number(old));
  } catch {}
  writeFileSync(PID_FILE, String(process.pid));
  const profile = Bun.spawnSync(["mcp", "--json", "--timeout", "60", "call", "claude.ai/slack", "slack_read_user_profile", "{}"]).stdout.toString();
  const me = profile.match(/User ID: (\w+)/)?.[1] ?? "";
  while (!(await fetch(`${base}/api/sessions`).then((r) => r.ok, () => false))) await Bun.sleep(2_000);
  log(`context feed as ${me || "?"}`);
  const first = !state.started;
  if (first) {
    // The first notice reaches back a day: the bus log's Slack events, then the slack sentry's store.
    state.seq = Number((await fetch(`${base}/api/events?topic=none&after=now`)).headers.get("x-maxflow-seq") ?? 0);
    const events = join(STATE_DIR, "events.jsonl");
    for (const line of (existsSync(events) ? readFileSync(events, "utf8") : "").split("\n")) {
      if (!line.includes('"topic":"slack/')) continue;
      try {
        const e = JSON.parse(line);
        if (Date.now() - e.at < BACKFILL_MS) onEvent(e.topic, e.data, me);
      } catch {}
    }
    sweep(me, Date.now() - BACKFILL_MS);
    state.sweptAt = Date.now();
    // The agent beside it needs a moment to come up before its first prompt.
    await Bun.sleep(20_000);
    await flush(true);
    state.started = true;
    save();
  }
  for (;;) {
    try {
      const wait = state.pending.length ? Math.max(1_000, state.firstAt + FLUSH_MS - Date.now()) : 60_000;
      const events = (await (await fetch(`${base}/api/events?topic=slack/**&after=${state.seq}&wait=${wait}`)).json()) as { seq: number; topic: string; data: any }[];
      for (const e of events) (state.seq = e.seq), onEvent(e.topic, e.data, me);
      if (Date.now() - state.sweptAt >= SWEEP_MS) {
        const n = sweep(me, state.sweptAt - 5 * 60_000);
        if (n) log(`sweep found ${n} messages no event carried`);
        state.sweptAt = Date.now();
      }
      if (state.pending.length && Date.now() - state.firstAt >= FLUSH_MS) await flush(false);
      save();
    } catch (e) {
      log(`tick failed: ${e}`);
      await Bun.sleep(10_000);
    }
    // Exits with the agent's pane, or once a newer feed took over.
    if (process.ppid === 1 || readFileSync(PID_FILE, "utf8") !== String(process.pid)) process.exit(0);
  }
}
