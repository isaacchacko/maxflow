#!/usr/bin/env bun
// assistant sentry's feed: runs beside the assistant agent (sentries/assistant.md) in its pane. Every minute it reads the part of each
// session's transcript it hasn't read yet for the user's own prompts (sentries' panes included, so what he types to the funnel counts)
// and the reply each agent ended its turn on, and the bus for question, wait, intent and PR events. It hands the assistant a digest
// within a minute of anything the user asked, and otherwise every 10 minutes, and looks up the state of every PR the open tasks link,
// which the server reads to settle each task's column. Exits with the agent.
import { existsSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const STATE_FILE = join(STATE_DIR, "assistant-state.json");
const DIGEST_FILE = join(STATE_DIR, "assistant-digest.json");
const PRS_FILE = join(STATE_DIR, "task-prs.json");
// How often the feed reads, and so how soon a digest follows something the user asked; the rest waits for the next digest.
const READ_MS = Number(process.env.ASSISTANT_READ_MS ?? 60_000);
const INTERVAL_MS = Number(process.env.ASSISTANT_INTERVAL ?? 10 * 60_000);
// The first read reaches back this far, so the board starts with the day's work instead of empty.
const BACKFILL_MS = Number(process.env.ASSISTANT_BACKFILL_MS ?? 24 * 3_600_000);
const NOTIFY_CHARS = 8_000;
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

type Session = { id: string; name: string; sentry: boolean; agent: boolean; status: string; transcript?: string; asleep?: boolean; wait: { kind: string; ref: string } | null };
type Question = { id: number; session: string; name: string; status: string; thread: { from: string; text: string }[] };
type Event = { seq: number; at: number; topic: string; data: any };
type Mark = { offset: number; reply?: string };
type Prompt = { at: string; session: string; title: string; text: string };
type Reply = { session: string; title: string; status: string; wait: string | null; text: string };
// What the next digest will carry; urgent once it holds something the user asked.
type Pending = { prompts: Prompt[]; replies: Record<string, Reply>; events: string[]; urgent: boolean };
type State = { since: number; seq: number; marks: Record<string, Mark>; pending: Pending; digestAt: number };

const state: State = {
  since: Date.now() - BACKFILL_MS,
  seq: 0,
  marks: {},
  pending: { prompts: [], replies: {}, events: [], urgent: false },
  digestAt: 0,
  ...(existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}),
};
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };
const get = async <T>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;
const notify = (text: string) =>
  fetch(`${base}/api/sessions/${process.env.MAXFLOW_SESSION}/notify`, { method: "POST", headers: caller, body: JSON.stringify({ text: `[maxflow assistant] ${text}` }) });
// An asleep agent's status still reads as the screen it went to sleep on, often "working".
const busy = (s: Session) => s.status === "working" && !s.asleep;
const clip = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n)}…`);

// The bytes appended since the last read, cut at the last full line.
function delta(path: string, mark: Mark) {
  const size = statSync(path).size;
  if (size < mark.offset) mark.offset = 0;
  const buf = Buffer.alloc(size - mark.offset);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, buf.length, mark.offset);
  closeSync(fd);
  const end = buf.lastIndexOf(10) + 1;
  mark.offset += end;
  return buf.subarray(0, end).toString("utf8").split("\n").filter(Boolean);
}

// What the user typed, or null for what the server, isovim, a hook or the harness typed. The server stamps every message an agent or
// sentry sends with its sender and pastes it in, so an unstamped prompt is his. A funnel relay stamped verified is his too, but it is
// read where he typed it, in the funnel's pane, so the relay itself is skipped.
function usersWords(e: any): string | null {
  if (e.isMeta || e.isCompactSummary || e.isSidechain) return null;
  const content = e.message?.content;
  const raw = typeof content === "string" ? content : (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const text = raw
    .replace(/<pasted_content id="(\w+)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g, (_: string, _id: string, inner: string) =>
      /^\[(maxflow|isovim|from )/.test(inner) ? "" : inner)
    .trim();
  if (!text || /^(<|\[(maxflow|isovim|from |Request interrupted))|^This session is being continued/.test(text)) return null;
  return text;
}

function lastReply(lines: string[]) {
  for (const line of lines.toReversed()) {
    if (!line.includes('"assistant"')) continue;
    try {
      const e = JSON.parse(line);
      const text = e.type === "assistant" && !e.isSidechain ? (e.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim() : "";
      if (text) return text;
    } catch {}
  }
  return "";
}

// The events that move a task: a question raised or settled, an agent starting or ending a wait, the funnel routing one of the user's
// requests, the server settling a task's column from its agents' waits, the inbox sentry putting a Slack message or PR on the
// board, and a PR's milestones.
const MOVES = /^(question\/\w+\/\d+|wait\/\w+|intent\/\w+|inbox\/\w+|task\/\d+|gh\/.+\/pr\/\d+\/(opened|merged|closed|review|ci|decision))$/;
// What can't wait for the next digest: something the user asked, a question to or from him, the funnel routing his request.
const URGENT = /^(question|intent)\//;

const pending = state.pending;

async function read() {
  const now = Date.now();
  const all = (await get<Session[]>("/api/sessions")).filter((s) => s.agent && s.transcript && existsSync(s.transcript));
  const name = new Map(all.map((s) => [s.id, s.name]));
  for (const s of all) {
    const mark = (state.marks[s.transcript!] ??= { offset: Math.max(0, statSync(s.transcript!).size - 1_000_000) });
    const lines = delta(s.transcript!, mark);
    for (const line of lines) {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(e.timestamp);
      // What he types in the Ask panel the assistant reads for itself.
      const words = e.type === "user" && at >= state.since && s.id !== process.env.MAXFLOW_SESSION ? usersWords(e) : null;
      if (words) (pending.prompts.push({ at: new Date(at).toISOString(), session: s.id, title: s.name, text: clip(words, 2_000) }), (pending.urgent = true));
    }
    // A sentry's replies are its own bookkeeping, not work toward a task. An agent still on its turn hasn't said where it got to; its
    // reply is read once the turn ends.
    const reply = s.sentry || busy(s) ? "" : lastReply(lines);
    if (reply && reply !== mark.reply) {
      mark.reply = reply;
      pending.replies[s.id] = { session: s.id, title: s.name, status: s.status, wait: s.wait && `${s.wait.kind}:${s.wait.ref}`, text: clip(reply, 1_200) };
    }
  }
  const live = new Set(all.map((s) => s.transcript!));
  for (const path of Object.keys(state.marks)) if (!live.has(path)) delete state.marks[path];

  const fresh = await get<Event[]>(`/api/events?topic=**&after=${state.seq}`);
  const questions = new Map((await get<Question[]>("/api/questions")).map((q) => [q.id, q]));
  for (const e of fresh.filter((e) => MOVES.test(e.topic) && e.at >= state.since)) {
    const q = e.topic.startsWith("question/") ? questions.get(e.data?.id) : undefined;
    const who = e.data?.session && `${e.data.session} (${name.get(e.data.session) ?? "?"})`;
    const what = q ? `${q.name}: ${clip(q.thread[0].text, 600)}${q.thread.length > 1 ? ` ↳ ${q.thread.at(-1)!.from}: ${clip(q.thread.at(-1)!.text, 600)}` : ""}` : clip(JSON.stringify(e.data), 600);
    pending.events.push(`${new Date(e.at).toISOString()} ${e.topic}${who ? ` ${who}` : ""} ${what}`);
    if (URGENT.test(e.topic)) pending.urgent = true;
  }
  state.seq = fresh.at(-1)?.seq ?? state.seq;
  state.since = now;
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

type Task = { id: number; title: string; status: string; sessions: string[]; links: string[] };

// The state of every PR the open tasks link, in one GitHub query, for the board's merged counts and the server's waiting rule.
async function lookUpPrs() {
  const tasks = await get<Task[]>("/api/tasks");
  const urls = [...new Set(tasks.filter((t) => !["done", "dropped"].includes(t.status)).flatMap((t) => t.links.filter((l) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(l))))];
  if (!urls.length) return;
  const query = `{${urls.map((u, i) => `p${i}: resource(url: ${JSON.stringify(u)}) { ... on PullRequest { state } }`).join(" ")}}`;
  const out = Bun.spawnSync(["gh", "api", "graphql", "-f", `query=${query}`]);
  const data = JSON.parse(out.stdout.toString() || "{}").data;
  if (!data) return console.error(`PR lookup failed: ${out.stderr.toString().slice(0, 300)}`);
  writeFileSync(PRS_FILE, JSON.stringify(Object.fromEntries(urls.flatMap((u, i) => (data[`p${i}`]?.state ? [[u, data[`p${i}`].state]] : [])))));
}

async function digest() {
  const now = Date.now();
  const replies = Object.values(pending.replies);
  const { prompts, events } = pending;
  console.log(`${new Date(now).toLocaleTimeString()}  digest: ${prompts.length} prompts from the user, ${replies.length} replies, ${events.length} events`);
  if (prompts.length || replies.length || events.length) {
    writeFileSync(DIGEST_FILE, JSON.stringify({ at: now, prompts, replies, events }, null, 2));
    const text = [
      prompts.length && `The user's prompts:\n${prompts.map((p) => `- ${p.at} to ${p.session} (${p.title}): ${JSON.stringify(p.text)}`).join("\n")}`,
      replies.length && `Where agents ended their turns:\n${replies.map((r) => `- ${r.session} (${r.title}) ${r.status}${r.wait ? `, waits on ${r.wait}` : ""}: ${JSON.stringify(r.text)}`).join("\n")}`,
      events.length && `Events:\n${events.map((e) => `- ${e}`).join("\n")}`,
    ].filter(Boolean).join("\n\n");
    await notify(text.length <= NOTIFY_CHARS ? text : `${text.slice(0, NOTIFY_CHARS)}\n… cut here; the whole digest is in ${DIGEST_FILE}.`);
  }
  Object.assign(pending, { prompts: [], replies: {}, events: [], urgent: false });
  state.digestAt = now;
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

console.log(`assistant sentry: reads every ${READ_MS / 1000}s; a digest within a minute of anything the user asked, else every ${INTERVAL_MS / 60_000}m`);
// Started with the server, so wait for it to answer before the first read.
while (!(await fetch(`${base}/api/sessions`).then((r) => r.ok, () => false))) await Bun.sleep(2_000);
let lookedUp = 0;
for (;;) {
  try {
    if (Date.now() - lookedUp >= INTERVAL_MS) (await lookUpPrs(), (lookedUp = Date.now()));
    await read();
    if (pending.urgent || Date.now() - state.digestAt >= INTERVAL_MS) await digest();
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  read failed:`, e);
  }
  await Bun.sleep(READ_MS);
  if (process.ppid === 1) process.exit(0);
}
