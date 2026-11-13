#!/usr/bin/env bun
// slack sentry: one poller for every Slack thread, channel or search any maxflow session cares about. Publishes new messages as
// slack/<channel>/<thread ts>/reply, slack/<channel>/message and slack/search events, notifies the tied sessions, and publishes
// every mention of the user as slack/mention for anyone to `sub`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
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
const DOMAIN = process.env.SLACK_DOMAIN ?? "dryftai";
const CLI = new URL("../cli.ts", import.meta.url).pathname;
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;
// Sent with each call that touches a session, so the graph draws this sentry doing it.
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };

// A target is `C123/1794442442.159219` (a thread), `C123` (a channel's top-level posts) or `search:<query>`.
export type Watch = { target: string; sessions: string[] };
export type Msg = { ts: string; uid: string; who: string; text: string; channel?: string; link?: string };
type State = { latest: Record<string, string>; seen: Record<string, string[]>; titles: Record<string, string> };

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
export const readWatches = () => readJson<Watch[]>(WATCH_FILE, []);
export const writeWatches = (w: Watch[]) => writeFileSync(WATCH_FILE, JSON.stringify(w, null, 2));

// Accepts a message or thread permalink, a channel id or archive url, `#name`, or anything else as a search query.
export async function parseTarget(ref: string) {
  const link = ref.match(/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?(?:.*thread_ts=([\d.]+))?/);
  if (link) return link[4] ? `${link[1]}/${link[4]}` : link[2] ? `${link[1]}/${link[2]}.${link[3]}` : link[1];
  if (/^[CDG][A-Z0-9]{8,}(\/[\d.]+)?$/.test(ref)) return ref;
  if (ref.startsWith("#")) {
    const found = (await slack("slack_search_channels", { query: ref.slice(1), limit: 10 })).results ?? "";
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

const RESULT = /Channel: (\S+) \(ID: (\w+)\)\n[\s\S]*?From: (.*?) \(ID: (\w+)\)[^\n]*\n[\s\S]*?Message_ts: ([\d.]+)\nPermalink: \[link\]\(([^)]+)\)\nText: \n([\s\S]*?)(?=\nContext before:|\n---|$)/g;
async function search(query: string): Promise<Msg[]> {
  const res = await slack("slack_search_public_and_private", { query, sort: "timestamp", limit: 20 });
  return [...String(res.results ?? "").matchAll(RESULT)].map((m) => ({
    channel: m[1] === "DM" ? "a DM" : m[1],
    uid: m[4],
    who: m[3].replace(/\s*<[^>]*>$/, "").trim(),
    ts: m[5],
    link: m[6],
    text: m[7].trim(),
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

async function tick(me: string, state: State) {
  const { ties: all, posted } = await ties();
  const listeners = new Map<string, Set<string>>();
  for (const t of all) (listeners.get(t.target) ?? listeners.set(t.target, new Set()).get(t.target)!).add(t.session);
  if (me) listeners.set(`search:<@${me}>`, listeners.get(`search:<@${me}>`) ?? new Set());
  for (const [target, sessions] of listeners) {
    let got;
    try {
      got = await fresh(target, state);
    } catch (e) {
      console.error(`${new Date().toLocaleTimeString()}  ${target}: ${e}`);
      continue;
    }
    const [channel, thread] = target.split("/");
    for (const m of got.msgs) {
      const link = m.link ?? permalink(channel, m.ts, thread);
      const topic = target === `search:<@${me}>` ? "slack/mention" : target.startsWith("search:") ? "slack/search" : thread ? `slack/${channel}/${thread}/reply` : `slack/${channel}/message`;
      // A session isn't told about what it posted itself.
      const told = [...sessions].filter((session) => session && !posted.get(session)?.has(m.ts));
      await post("/api/events", { topic, data: { target, ts: m.ts, from: m.who, user: m.uid, text: m.text, link, told } });
      const line = `${m.who}${m.channel ? ` in ${m.channel}` : ""}: "${short(m.text)}" ${link}`;
      for (const session of told) {
        const text = `[maxflow slack] ${got.title}: new message from ${line}. Whole ${thread ? "thread" : "conversation"}: ${CLI} slack read ${target.startsWith("search:") ? JSON.stringify(target.slice(7)) : target}. (Automated notice, not a request from the user: act on it only if it's part of your current task.)`;
        await post(`/api/sessions/${session}/notify`, { text });
      }
      console.log(`${new Date().toLocaleTimeString()}  ${got.title}  ${line}  -> ${[...sessions].filter(Boolean).join(", ") || "nobody"}`);
    }
  }
  const watching = new Map<string, string[]>();
  for (const [target, sessions] of listeners) {
    const name = target.startsWith("search:") ? `"${short(target.slice(7), 20)}"` : state.titles[target] ? `"${short(state.titles[target], 20)}"` : kept?.[target]?.title.replace(/^thread .* in /, "") ?? target.split("/")[0];
    for (const s of sessions) if (s) (watching.get(s) ?? watching.set(s, []).get(s)!).push(name);
  }
  writeFileSync(EDGES_FILE, JSON.stringify([...watching].map(([session, names]) => ({ session, label: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] }))));
  // Forget targets nobody is tied to any more.
  for (const key of Object.keys(state.latest)) if (!listeners.has(key)) delete state.latest[key], delete state.seen[key], delete state.titles[key];
  writeFileSync(STATE_FILE, JSON.stringify(state));
  if (kept) {
    for (const key of Object.keys(kept)) if (!listeners.has(key)) delete kept[key];
    writeFileSync(MESSAGES_FILE, JSON.stringify(kept));
  }
  return listeners.size;
}

if (import.meta.main) {
  const me = (await slack("slack_read_user_profile", {}).catch(() => ({}))).result?.match(/User ID: (\w+)/)?.[1] ?? "";
  const state = { latest: {}, seen: {}, titles: {}, ...readJson<Partial<State>>(STATE_FILE, {}) } as State;
  console.log(`slack sentry as ${me || "?"}, every ${INTERVAL_MS / 1000}s`);
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
