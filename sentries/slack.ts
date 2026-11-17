#!/usr/bin/env bun
// slack sentry: one poller for every Slack thread, channel or search any maxflow session cares about. Publishes new messages as
// slack/<channel>/<thread ts>/reply, slack/<channel>/message and slack/search events, notifies the tied sessions, and publishes
// every mention of the user as slack/mention, every DM to him as slack/dm and every post of his own as slack/own for anyone to `sub`.
// His DMs are read directly every tick, not only found through search, whose index lags minutes; each Slack notification this Mac
// shows (slack-notify.ts) is published as slack/notify and reads its conversation at once.
// A thread he posts in himself (not through an agent) is tied to nobody for a while, so its replies are published even with no session
// on it; sentries/inbox.ts takes what no session heard.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE as base, STATE_DIR } from "../instance";
import { watchNotices, type Notice } from "./slack-notify";

const WATCH_FILE = join(STATE_DIR, "slack-watch.json");
const STATE_FILE = join(STATE_DIR, "slack-state.json");
// The latest messages of each target, so `maxflow slack read` can answer without asking Slack.
const MESSAGES_FILE = join(STATE_DIR, "slack-messages.json");
// This sentry's graph edges, one per tied session, labeled by what it watches.
const EDGES_FILE = join(STATE_DIR, "slack-edges.json");
const KEEP = 50;
const PROJECTS = join(process.env.HOME!, ".claude", "projects");
const INTERVAL_MS = Number(process.env.SLACK_SENTRY_INTERVAL ?? 60_000);
// Threads a session posted in stay tied to it this long after its last post there.
const POSTED_TIE_MS = Number(process.env.SLACK_POSTED_TIE_MS ?? 3 * 86_400_000);
// Threads the user posts in himself stay watched this long, read at most every OWN_READ_MS so they don't stretch the tick.
const OWN_TIE_MS = Number(process.env.SLACK_OWN_TIE_MS ?? 2 * 86_400_000);
const OWN_READ_MS = Number(process.env.SLACK_OWN_READ_MS ?? 5 * 60_000);
const DOMAIN = process.env.SLACK_DOMAIN ?? "dryftai";
// The DM conversations read each tick: the ones that moved in the last DM_TIE_MS, at most DM_READS of them.
const DM_TIE_MS = Number(process.env.SLACK_DM_TIE_MS ?? 3 * 86_400_000);
const DM_READS = Number(process.env.SLACK_DM_READS ?? 8);
const CLI = new URL("../cli.ts", import.meta.url).pathname;
// Sent with each call that touches a session, so the graph draws this sentry doing it.
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };

// A target is `C123/1794442442.159219` (a thread), `C123` (a channel's top-level posts) or `search:<query>`.
export type Watch = { target: string; sessions: string[] };
export type Msg = { ts: string; uid: string; who: string; text: string; channel?: string; link?: string; bot?: boolean };
// own: the threads the user posted in himself, with when he last did; readAt: when each was last read; bots: authors search marked [BOT].
// dms: his DM conversations by channel id, with the other person and when it last moved; places: a notification's subtitle as the
// conversation it names (null when it names none we can read); direct: the ts of DMs and own posts published, so search's later copy isn't.
type State = {
  latest: Record<string, string>;
  seen: Record<string, string[]>;
  titles: Record<string, string>;
  own: Record<string, number>;
  readAt: Record<string, number>;
  bots: string[];
  ownSeeded?: boolean;
  dms: Record<string, { who: string; at: number }>;
  places: Record<string, string | null>;
  direct: string[];
};

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
export const readWatches = () => readJson<Watch[]>(WATCH_FILE, []);
export const writeWatches = (w: Watch[]) => writeFileSync(WATCH_FILE, JSON.stringify(w, null, 2));

// Accepts a message or thread permalink, a channel id or archive url, `#name`, or anything else as a search query.
export async function parseTarget(ref: string) {
  const link = ref.match(/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?(?:.*thread_ts=([\d.]+))?/);
  if (link) return link[4] ? `${link[1]}/${link[4]}` : link[2] ? `${link[1]}/${link[2]}.${link[3]}` : link[1];
  if (/^[CDG][A-Z0-9]{8,}(\/[\d.]+)?$/.test(ref)) return ref;
  if (ref.startsWith("#")) {
    const found = (await slack("slack_search_channels", { keywords: [ref.slice(1)], channel_types: "public_channel,private_channel", limit: 10 })).results ?? "";
    const id = [...found.matchAll(/Name: #([\w.-]+)\n[\s\S]*?archives\/([A-Z0-9]+)/g)].find((m) => m[1] === ref.slice(1))?.[2];
    return id ?? null;
  }
  return `search:${ref.replace(/^search:/, "")}`;
}

async function slack(tool: string, args: Record<string, unknown>) {
  const proc = Bun.spawn(["mcp", "--json", "--timeout", "60", "call", "claude.ai/slack", tool, JSON.stringify(args)], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(9), 90_000);
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  clearTimeout(timer);
  if ((await proc.exited) !== 0) throw new Error(`${tool}: ${(err || out).trim().slice(0, 300)}`);
  const text = JSON.parse(out).content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// slack_read_thread and slack_read_channel print each message as a header naming the author, then `Message TS:`, then its text.
const HEADER = /(?:=== Message from (.*?) \((\w+)\) at [^\n]*?===|(?:=== THREAD PARENT MESSAGE ===|--- Reply \d+ of \d+ ---)\nFrom: (.*?) \((\w+)\)\nTime: [^\n]*)\s*\nMessage TS: ([\d.]+)\n/g;
function parseMessages(body: string): Msg[] {
  const heads = [...body.matchAll(HEADER)];
  return heads.map((h, i) => ({
    ts: h[5],
    uid: h[2] ?? h[4],
    who: (h[1] ?? h[3]).replace(/\s*<[^>]*>$/, "").trim() || h[2] || h[4],
    text: body
      .slice(h.index! + h[0].length, heads[i + 1]?.index ?? body.length)
      .replace(/\n(?:=== THREAD REPLIES[^\n]*|Thread: \d+ repl[^\n]*|Reactions: [^\n]*|Files: [^\n]*)/g, "")
      .trim(),
  }));
}

const RESULT = /Channel: (\S+) \(ID: (\w+)\)\n[\s\S]*?From: (.*?) \(ID: (\w+)\)([^\n]*)\n[\s\S]*?Message_ts: ([\d.]+)\nPermalink: \[link\]\(([^)]+)\)\nText: \n([\s\S]*?)(?=\nContext before:|\n---|$)/g;
async function search(query: string): Promise<Msg[]> {
  const res = await slack("slack_search_public_and_private", { query, sort: "timestamp", limit: 20 });
  return [...String(res.results ?? "").matchAll(RESULT)].map((m) => ({
    channel: m[1] === "DM" ? "a DM" : m[1],
    uid: m[4],
    who: m[3].replace(/\s*<[^>]*>$/, "").trim(),
    bot: m[5].includes("[BOT]"),
    ts: m[6],
    link: m[7],
    text: m[8].trim(),
  }));
}

export const permalink = (channel: string, ts: string, thread?: string) =>
  `https://${DOMAIN}.slack.com/archives/${channel}/p${ts.replace(".", "")}${thread && thread !== ts ? `?thread_ts=${thread}&cid=${channel}` : ""}`;

type Session = { id: string; name: string; running: boolean; sentry: boolean; chatId?: string; transcript?: string };
type Tie = { target: string; session: string };

// Threads a session's agent posted in through the Slack connector, read from its transcript, plus the ts of every message it posted.
const scanned = new Map<string, { offset: number; sends: Set<string>; threads: Map<string, number>; posted: Set<string> }>();
function postedBy(s: Session) {
  const path = s.transcript ?? (s.chatId ? [...new Bun.Glob(`*/${s.chatId}.jsonl`).scanSync(PROJECTS)].map((f) => join(PROJECTS, f))[0] : undefined);
  if (!path || !existsSync(path)) return undefined;
  const memo = scanned.get(path) ?? scanned.set(path, { offset: 0, sends: new Set(), threads: new Map(), posted: new Set() }).get(path)!;
  const fresh = readFileSync(path).subarray(memo.offset);
  const end = fresh.lastIndexOf(10) + 1;
  memo.offset += end;
  for (const line of fresh.subarray(0, end).toString().split("\n")) {
    if (!line.includes("slack_send_message") && !line.includes("message_context")) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry.timestamp ?? "") || Date.now();
    for (const c of entry.message?.content ?? []) {
      if (c.type === "tool_use" && String(c.name).endsWith("slack_send_message")) memo.sends.add(c.id);
      if (c.type !== "tool_result" || !memo.sends.delete(c.tool_use_id)) continue;
      const text = Array.isArray(c.content) ? c.content.map((p: any) => p.text ?? "").join("") : String(c.content ?? "");
      const sent = text.match(/"message_ts":"([\d.]+)","channel_id":"(\w+)"/);
      if (!sent) continue;
      const target = `${sent[2]}/${text.match(/thread_ts=([\d.]+)/)?.[1] ?? sent[1]}`;
      memo.posted.add(sent[1]);
      memo.threads.set(target, Math.max(at, memo.threads.get(target) ?? 0));
    }
  }
  return memo;
}

async function ties(): Promise<{ ties: Tie[]; posted: Map<string, Set<string>> }> {
  const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as Session[];
  const live = sessions.filter((s) => s.running && !s.sentry);
  const alive = new Set(live.map((s) => s.id));
  const found: Tie[] = [];
  const posted = new Map<string, Set<string>>();
  // Explicit watches end when every session they were for has.
  const watches = readWatches();
  const kept = watches.flatMap((w) => {
    const sessions = w.sessions.filter((id) => alive.has(id));
    return w.sessions.length && !sessions.length ? [] : [{ ...w, sessions }];
  });
  if (kept.length !== watches.length || kept.some((w, i) => w.sessions.length !== watches[i].sessions.length)) writeWatches(kept);
  for (const w of kept) for (const session of w.sessions.length ? w.sessions : [""]) found.push({ target: w.target, session });
  for (const s of live) {
    const mine = postedBy(s);
    if (!mine) continue;
    posted.set(s.id, mine.posted);
    for (const [target, at] of mine.threads) if (Date.now() - at < POSTED_TIE_MS) found.push({ target, session: s.id });
  }
  return { ties: found, posted };
}

const short = (text: string, n = 300) => (text.replace(/\s+/g, " ").trim().slice(0, n) + (text.length > n ? "…" : "")).trim();
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: caller, body: JSON.stringify(body) });

// A target's messages, oldest first, newer than `oldest` when given.
export async function read(target: string, oldest?: string): Promise<{ msgs: Msg[]; title: string; name: string }> {
  const query = `search "${short(target.slice(7), 60)}"`;
  if (target.startsWith("search:")) return { msgs: (await search(target.slice(7))).reverse(), title: query, name: query };
  const [channel, thread] = target.split("/");
  const res = thread
    ? await slack("slack_read_thread", { channel_id: channel, message_ts: thread, ...(oldest ? { oldest } : { limit: 1000 }) })
    : await slack("slack_read_channel", { channel_id: channel, limit: 50, ...(oldest ? { oldest } : {}) });
  const body = String(res.messages ?? res.raw ?? "");
  const msgs = parseMessages(body).sort((a, b) => Number(a.ts) - Number(b.ts));
  const name = body.match(/^Channel: (#\S+)/)?.[1] ?? channel;
  const parent = thread && msgs.find((m) => m.ts === thread);
  return { msgs, title: thread ? `thread ${parent ? `"${short(parent.text, 60)}"` : thread} in ${name}` : name, name };
}

// New messages on a target since the last tick; the first look at a target only records where it stands.
async function fresh(target: string, state: State): Promise<{ msgs: Msg[]; title: string }> {
  const prev = state.latest[target];
  if (target.startsWith("search:")) {
    const { msgs: hits, title } = await read(target);
    const seen = new Set(state.seen[target] ?? []);
    state.seen[target] = [...seen, ...hits.map((m) => m.ts)].slice(-500);
    state.latest[target] ??= "seen";
    keep(target, title, hits);
    return { msgs: prev ? hits.filter((m) => !seen.has(m.ts)) : [], title };
  }
  const thread = target.split("/")[1];
  const got = await read(target, prev);
  const parent = thread && got.msgs.find((m) => m.ts === thread);
  if (parent) state.titles[target] = short(parent.text, 60);
  const newest = got.msgs.at(-1)?.ts;
  if (newest && (!prev || Number(newest) > Number(prev))) state.latest[target] = newest;
  else state.latest[target] ??= `${(Date.now() / 1000).toFixed(6)}`;
  const title = thread ? `thread ${state.titles[target] ? `"${state.titles[target]}"` : thread} in ${got.name}` : got.name;
  keep(target, title, got.msgs);
  return { msgs: prev ? got.msgs.filter((m) => Number(m.ts) > Number(prev) && m.ts !== thread) : [], title };
}

type Kept = Record<string, { at: number; title: string; msgs: Msg[] }>;
export const readMessages = () => readJson<Kept>(MESSAGES_FILE, {});
let kept: Kept | undefined;
function keep(target: string, title: string, msgs: Msg[]) {
  kept ??= readMessages();
  const byTs = new Map([...(kept[target]?.msgs ?? []), ...msgs].map((m) => [m.ts, m]));
  // A thread's parent always stays, so a read shows what the thread is about.
  const thread = target.split("/")[1];
  const all = [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  const parent = thread ? all.filter((m) => m.ts === thread) : [];
  kept[target] = { at: Date.now(), title, msgs: [...parent, ...all.filter((m) => m.ts !== thread).slice(-KEEP)] };
}

// The searches every tick makes for the user, whoever else is tied to them, and the topic each publishes.
const own = (me: string) => ({ [`search:<@${me}>`]: "slack/mention", [`search:to:<@${me}>`]: "slack/dm", [`search:from:<@${me}>`]: "slack/own" });
// The thread a search hit sits in, as a target.
const threadOf = (link: string) => link.match(/archives\/(\w+)\/p(\d{10})(\d{6})(?:\?thread_ts=([\d.]+))?/)?.slice(1);
const targetOf = (link: string) => { const t = threadOf(link); return t && `${t[0]}/${t[3] ?? `${t[1]}.${t[2]}`}`; };

// The ts of each DM and own post published, shared by ticks and notifications so neither publishes one twice.
let published: Set<string> | undefined;
const reading = new Map<string, Promise<unknown>>();
async function exclusive(target: string, f: () => Promise<unknown>) {
  while (reading.has(target)) await reading.get(target);
  const run = f();
  reading.set(target, run);
  try {
    await run;
  } finally {
    reading.delete(target);
  }
}

// The DM conversations worth reading this tick, newest first.
const liveDms = (state: State) =>
  Object.entries(state.dms)
    .filter(([, d]) => Date.now() - d.at < DM_TIE_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, DM_READS)
    .map(([id]) => id);

// Every tick reads all it listens to; `only` reads just those targets now, for a notification, and leaves the rest for the next tick.
async function tick(me: string, state: State, only?: Set<string>) {
  const { ties: all, posted } = await ties();
  const listeners = new Map<string, Set<string>>();
  for (const t of all) (listeners.get(t.target) ?? listeners.set(t.target, new Set()).get(t.target)!).add(t.session);
  const searches = me ? own(me) : {};
  for (const target of Object.keys(searches)) listeners.set(target, listeners.get(target) ?? new Set());
  for (const [target, at] of Object.entries(state.own)) if (Date.now() - at < OWN_TIE_MS) listeners.set(target, listeners.get(target) ?? new Set());
  for (const target of liveDms(state)) listeners.set(target, listeners.get(target) ?? new Set());
  const byAgent = new Set([...posted.values()].flatMap((s) => [...s]));
  const bots = new Set(state.bots);
  const direct = (published ??= new Set(state.direct));
  for (const [target, sessions] of listeners) {
    if (only && !only.has(target)) continue;
    // A thread only the user's own post ties is read every OWN_READ_MS, not every tick.
    if (!only && state.own[target] && ![...sessions].some(Boolean) && Date.now() - (state.readAt[target] ?? 0) < OWN_READ_MS) continue;
    // A notification's read and a tick's never read the same conversation at once.
    await exclusive(target, async () => {
      state.readAt[target] = Date.now();
      let got;
      try {
        got = await fresh(target, state);
      } catch (e) {
        console.error(`${new Date().toLocaleTimeString()}  ${target}: ${e}`);
        return;
      }
      // The first look at his own posts ties the threads he posted in lately, which a first look would otherwise only record.
      if (!state.ownSeeded && target === `search:from:<@${me}>`) {
        state.ownSeeded = true;
        for (const m of kept?.[target]?.msgs ?? []) {
          const at = !byAgent.has(m.ts) && m.link && targetOf(m.link);
          if (at && Date.now() - Number(m.ts) * 1000 < OWN_TIE_MS) state.own[at] = Math.max(state.own[at] ?? 0, Number(m.ts) * 1000);
        }
      }
      // A DM search hit names a conversation to read directly from now on.
      if (target === `search:to:<@${me}>` || target === `search:from:<@${me}>`)
        for (const m of kept?.[target]?.msgs ?? []) {
          const dm = m.link?.match(/archives\/(D\w+)/)?.[1];
          if (!dm) continue;
          const d = (state.dms[dm] ??= { who: "", at: 0 });
          d.at = Math.max(d.at, Number(m.ts) * 1000);
          // Read on from the last DM search saw, not from whenever the first direct read happens, so nothing between is lost.
          if (!state.latest[dm] || Number(state.latest[dm]) < Number(m.ts)) state.latest[dm] = m.ts;
          if (m.uid !== me) d.who = m.who;
        }
      const dm = state.dms[target];
      if (dm) {
        const theirs = got.msgs.findLast((m) => m.uid !== me);
        if (theirs) dm.who = theirs.who;
        if (got.msgs.length) dm.at = Math.max(dm.at, Number(got.msgs.at(-1)!.ts) * 1000);
      }
      const [channel, thread] = target.split("/");
      for (const m of got.msgs) {
        const link = m.link ?? permalink(channel, m.ts, thread);
        const topic = searches[target] ?? (dm ? (m.uid === me ? "slack/own" : "slack/dm") : target.startsWith("search:") ? "slack/search" : thread ? `slack/${channel}/${thread}/reply` : `slack/${channel}/message`);
        // A DM or own post read directly is published once: search finds the same message minutes later.
        if (topic === "slack/dm" || topic === "slack/own") {
          if (direct.has(m.ts)) continue;
          direct.add(m.ts);
        }
        if (m.bot) bots.add(m.uid);
        const agent = byAgent.has(m.ts);
        // What the user posts himself ties its thread to nobody, so replies there are published for sentries/inbox.ts.
        const at = target === `search:from:<@${me}>` && !agent && m.link && targetOf(m.link);
        if (at) state.own[at] = Date.now();
        // A session isn't told about what it posted itself.
        const told = [...sessions].filter((session) => session && !posted.get(session)?.has(m.ts));
        await post("/api/events", { topic, data: { target, thread: m.link ? targetOf(m.link) : thread ? target : undefined, ts: m.ts, from: m.who, user: m.uid, text: m.text, link, told, bot: bots.has(m.uid), agent, where: m.channel ?? got.title } });
        const line = `${m.who}${m.channel ? ` in ${m.channel}` : ""}: "${short(m.text)}" ${link}`;
        for (const session of told) {
          const text = `[maxflow slack] ${got.title}: new message from ${line}. Whole ${thread ? "thread" : "conversation"}: ${CLI} slack read ${target.startsWith("search:") ? JSON.stringify(target.slice(7)) : target}. (Automated notice, not a request from the user: act on it only if it's part of your current task.)`;
          await post(`/api/sessions/${session}/notify`, { text });
        }
        console.log(`${new Date().toLocaleTimeString()}  ${got.title}  ${line}  -> ${[...sessions].filter(Boolean).join(", ") || "nobody"}`);
      }
    });
  }
  state.direct = [...direct].slice(-1000);
  if (only) {
    writeFileSync(STATE_FILE, JSON.stringify(state));
    if (kept) writeFileSync(MESSAGES_FILE, JSON.stringify(kept));
    return listeners.size;
  }
  const watching = new Map<string, string[]>();
  for (const [target, sessions] of listeners) {
    const name = target.startsWith("search:") ? `"${short(target.slice(7), 20)}"` : state.titles[target] ? `"${short(state.titles[target], 20)}"` : kept?.[target]?.title.replace(/^thread .* in /, "") ?? target.split("/")[0];
    for (const s of sessions) if (s) (watching.get(s) ?? watching.set(s, []).get(s)!).push(name);
  }
  writeFileSync(EDGES_FILE, JSON.stringify([...watching].map(([session, names]) => ({ session, label: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] }))));
  // Forget targets nobody is tied to any more.
  for (const key of Object.keys(state.latest)) if (!listeners.has(key)) delete state.latest[key], delete state.seen[key], delete state.titles[key];
  for (const key of Object.keys(state.own)) if (!listeners.has(key)) delete state.own[key], delete state.readAt[key];
  for (const key of Object.keys(state.readAt)) if (!listeners.has(key)) delete state.readAt[key];
  state.bots = [...bots];
  writeFileSync(STATE_FILE, JSON.stringify(state));
  if (kept) {
    for (const key of Object.keys(kept)) if (!listeners.has(key)) delete kept[key];
    writeFileSync(MESSAGES_FILE, JSON.stringify(kept));
  }
  return listeners.size;
}

// What a notification's subtitle names: `#channel` or a private channel's bare name is a channel; anything else is a person, whose
// DM a read by their user id finds. Cached, misses included, since each lookup is a Slack call.
async function placeOf(subtitle: string, state: State): Promise<string | null> {
  if (subtitle in state.places) return state.places[subtitle]!;
  const known = Object.entries(state.dms).find(([, d]) => d.who === subtitle)?.[0];
  let place: string | null = known ?? null;
  if (!place) {
    const channels = String((await slack("slack_search_channels", { keywords: [subtitle.replace(/^#/, "")], channel_types: "public_channel,private_channel", limit: 5 })).results ?? "");
    place = [...channels.matchAll(/Name: #([\w.-]+)\n[\s\S]*?archives\/([A-Z0-9]+)/g)].find((m) => m[1] === subtitle.replace(/^#/, ""))?.[2] ?? null;
  }
  if (!place && !subtitle.startsWith("#")) {
    const users = String((await slack("slack_search_users", { keywords: subtitle.split(/\s+/), limit: 5 })).results ?? "");
    const uid = [...users.matchAll(/Name: (.*?)\n[\s\S]*?User ID: (\w+)/g)].find((m) => m[1]!.trim() === subtitle)?.[2];
    const dm = uid && String((await slack("slack_read_channel", { channel_id: uid, limit: 1 })).messages ?? "").match(/^Channel: DM \((D\w+)\)/)?.[1];
    place = dm || null;
  }
  return (state.places[subtitle] = place);
}

// A notification is published as it is, then its conversation is read now so the whole message lands through the usual path.
async function onNotice(n: Notice, me: string, state: State) {
  await post("/api/events", { topic: "slack/notify", data: { title: n.title, subtitle: n.subtitle, body: n.body, ts: n.ts, at: n.at } });
  const place = await placeOf(n.subtitle, state).catch((e) => (console.error(`notice "${n.subtitle}": ${e}`), null));
  console.log(`${new Date().toLocaleTimeString()}  notice from ${n.subtitle} (${place ?? "unknown"}), ${((Date.now() - n.at) / 1000).toFixed(1)}s after delivery`);
  if (!place || !n.ts) return;
  if (place.startsWith("D")) {
    // A conversation new to the sentry starts just before this message, so the read publishes it instead of only recording it.
    const d = (state.dms[place] ??= { who: n.subtitle, at: 0 });
    d.at = Math.max(d.at, n.at);
    state.latest[place] ??= (Number(n.ts) - 1).toFixed(6);
    return void (await tick(me, state, new Set([place])));
  }
  // In a channel: a top-level post that mentions him is his mention now; anything else (a reply in a thread he's in) is read
  // with the threads he's tied to there.
  const { msgs } = await read(place, (Number(n.ts) - 1).toFixed(6));
  const m = msgs.find((x) => x.ts === n.ts);
  const mentions = `search:<@${me}>`;
  if (m && m.text.includes(`<@${me}>`) && !state.seen[mentions]?.includes(m.ts)) {
    state.seen[mentions] = [...(state.seen[mentions] ?? []), m.ts].slice(-500);
    await post("/api/events", { topic: "slack/mention", data: { target: mentions, thread: `${place}/${m.ts}`, ts: m.ts, from: m.who, user: m.uid, text: m.text, link: permalink(place, m.ts), told: [], bot: state.bots.includes(m.uid), agent: false, where: n.subtitle } });
    writeFileSync(STATE_FILE, JSON.stringify(state));
    return;
  }
  if (!m) {
    const { ties: tied } = await ties();
    const here = new Set([...tied.map((t) => t.target), ...Object.keys(state.own)].filter((t) => t.startsWith(`${place}/`)));
    if (here.size) await tick(me, state, here);
  }
}

if (import.meta.main) {
  const me = (await slack("slack_read_user_profile", {}).catch(() => ({}))).result?.match(/User ID: (\w+)/)?.[1] ?? "";
  const state = { latest: {}, seen: {}, titles: {}, own: {}, readAt: {}, bots: [], dms: {}, places: {}, direct: [], ...readJson<Partial<State>>(STATE_FILE, {}) } as State;
  // A notification is handled at once, beside a tick that may be running; `exclusive` keeps them off the same conversation.
  // SLACK_NOTICES_SINCE=<record id> replays the notifications after it, for a test.
  const notices = watchNotices((n) => void onNotice(n, me, state).catch((e) => console.error(`${new Date().toLocaleTimeString()}  notice failed:`, e)), Number(process.env.SLACK_NOTICES_SINCE) || undefined);
  console.log(`slack sentry as ${me || "?"}, every ${INTERVAL_MS / 1000}s; notifications ${notices ? "watched" : "unreadable, polling only"}`);
  for (;;) {
    try {
      const n = await tick(me, state);
      process.title = `slack sentry (${n} targets)`;
    } catch (e) {
      console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
    }
    await Bun.sleep(INTERVAL_MS);
  }
}
