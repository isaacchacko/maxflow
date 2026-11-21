import { publish } from "./bus";
import { CLI } from "./instance";
import type { Thread } from "./model";
import { type Session, isSentry, sessions } from "./sessions";
import { dispatch, endWait, isReachable, isWaitingOn } from "./lifecycle";
import { unforge } from "./threads";
import { threads } from "./stores";
import { readStateJson, writeStateJson } from "./state";
import { AGENT_BOARD_CONFIG, agentBoardUrl } from "./agent-board-config";
import { isRecord } from "./shared/guards";
import { recordIsaacSaid } from "./isaac-words";

const SENT_FILE = "agent-board-sent.json";
const POST_MS = 5000;
const SENTRY_GRACE_MS = 30_000;
const SWEEP_MS = 10_000;
const SENT_KEPT = 500;

export const agentChannel = (id: string) => `yarn/agent/${id}`;
export const threadChannel = (id: string) => `yarn/thread/${id}`;
// constraint: a board profile is a letter, then up to 31 letters, numbers or hyphens
export const ISAAC_PROFILE = "isaac";
export const profileOf = (s: Session | undefined) => (s ? `yarn-${s.id}` : "yarn");

type Sent = { to?: string; from?: string; text: string; deliver?: string; at: number; delivered: boolean; isIsaac?: true };
type SentLog = Record<string, Sent>;
const isSentLog = (value: unknown): value is SentLog => isRecord(value);
const sent: SentLog = readStateJson(SENT_FILE, isSentLog) ?? {};

function keep(id: string, record: Sent) {
  sent[id] = record;
  const ids = Object.keys(sent);
  const kept = Object.fromEntries(ids.slice(-SENT_KEPT).map((x) => [x, sent[x]]));
  writeStateJson(SENT_FILE, kept);
  const dropped = ids.slice(0, Math.max(0, ids.length - SENT_KEPT));
  for (const old of dropped) Reflect.deleteProperty(sent, old);
}

export const boardUrl = agentBoardUrl;

type Posted = { id: string } | { error: string };

// constraint: the sentry can see a post before this server has recorded it, and must not take it for someone else's
const inFlight = { posts: 0 };

async function postToBoard(body: Record<string, unknown>, as: Session | "isaac" | undefined): Promise<Posted> {
  inFlight.posts += 1;
  try {
    return await postAndRead(body, as);
  } finally {
    inFlight.posts -= 1;
  }
}

async function postAndRead(body: Record<string, unknown>, as: Session | "isaac" | undefined): Promise<Posted> {
  const url = boardUrl();
  if (url === undefined) return { error: `no board configured (${AGENT_BOARD_CONFIG} in yarn's state folder)` };
  try {
    const res = await fetch(`${url}/messages`, { method: "POST", headers: { "content-type": "application/json", "x-board-profile": as === "isaac" ? ISAAC_PROFILE : profileOf(as) }, body: JSON.stringify(body), signal: AbortSignal.timeout(POST_MS) });
    if (!res.ok) return { error: `board answered ${String(res.status)}: ${(await res.text()).slice(0, 200)}` };
    const reply: unknown = await res.json();
    const id = isRecord(reply) && isRecord(reply["message"]) ? reply["message"]["id"] : undefined;
    return typeof id === "string" ? { id } : { error: "board answered without a message id" };
  } catch (error) {
    return { error: `board unreachable: ${String(error)}` };
  }
}

const isOpen = (t: Thread) => t.mergedInto === undefined && t.resolved === undefined;

const FELL_BACK = `\n[yarn] The board didn't hand this over within ${String(SENTRY_GRACE_MS / 1000)}s, so it came directly.`;

function typeInto(to: Session, from: Session | undefined, record: Sent, isDirect: boolean) {
  dispatch({ ...(from && { from }), ...(record.isIsaac && { source: "isaac" as const }), to: [to], text: record.text, deliver: `${record.deliver ?? record.text}${isDirect ? FELL_BACK : ""}` });
  if (from && isWaitingOn(to, from.id)) endWait(to);
}

function deliverRecorded(id: string, record: Sent, how: "board" | "direct") {
  if (record.delivered) return;
  keep(id, { ...record, delivered: true });
  const to = sessions.get(record.to ?? "");
  if (!to || !isReachable(to)) return;
  const from = sessions.get(record.from ?? "");
  const isDirect = how === "direct";
  typeInto(to, from, record, isDirect);
  if (isDirect) publish("board-bus/fallback", { id, to: to.id, from: from?.id ?? null, why: "not handed over by the board sentry in time" });
}

function sweepUndelivered() {
  const now = Date.now();
  for (const [id, record] of Object.entries(sent)) if (!record.delivered && now - record.at >= SENTRY_GRACE_MS) deliverRecorded(id, record, "direct");
}
setInterval(sweepUndelivered, SWEEP_MS).unref();

export type Carried = { via: "board"; id: string } | { via: "direct"; error: string };

// constraint: sentries' notices stay direct, so the board holds only the agents' conversation
export const isForTheBoard = (from: Session | undefined, to: Session) => from !== undefined && !isSentry(from) && !isSentry(to) && from.id !== to.id;

export async function carry(m: { from: Session; to: Session; text: string; deliver: string; isAlreadyTyped: boolean }): Promise<Carried> {
  const posted = await postToBoard({ channel: agentChannel(m.to.id), text: m.text }, m.from);
  if ("error" in posted) {
    if (m.isAlreadyTyped) dispatch({ from: m.from, to: [m.to], text: m.text, typed: true });
    else dispatch({ from: m.from, to: [m.to], text: m.text, deliver: `${m.deliver}\n[yarn] The agent board was down (${posted.error.slice(0, 120)}), so this came directly.` });
    if (isWaitingOn(m.to, m.from.id)) endWait(m.to);
    publish("board-bus/fallback", { to: m.to.id, from: m.from.id, why: posted.error });
    return { via: "direct", error: posted.error };
  }
  const record: Sent = { to: m.to.id, from: m.from.id, text: m.text, deliver: m.deliver, at: Date.now(), delivered: false };
  if (m.isAlreadyTyped) {
    keep(posted.id, { ...record, delivered: true });
    dispatch({ from: m.from, to: [m.to], text: m.text, typed: true });
  } else keep(posted.id, record);
  return { via: "board", id: posted.id };
}

export async function replyOnBoard(from: Session | undefined, re: string, text: string): Promise<Carried> {
  const posted = await postToBoard({ re, text }, from);
  if ("error" in posted) return { via: "direct", error: posted.error };
  keep(posted.id, { ...(from && { from: from.id }), text, at: Date.now(), delivered: true });
  return { via: "board", id: posted.id };
}

export type BoardPost = { id: string; channel: string; text: string; handle: string; device: string; re?: string };

const unverifiedStamp = (p: BoardPost) => `[yarn · from the board, "${p.handle}" via ${p.device}, not a yarn agent this server can vouch for]`;
const howToAnswer = (p: BoardPost) => `\n[yarn] Board message ${p.id} in ${p.channel}. Answer on the board with \`${CLI} board reply ${p.re ?? p.id} '<text>'\`.`;

function deliverToAgent(p: BoardPost, to: Session) {
  dispatch({ source: "agent", to: [to], target: p.handle, text: p.text, deliver: `${unverifiedStamp(p)} ${unforge(p.text)}${howToAnswer(p)}` });
}

function deliverToThread(p: BoardPost, t: Thread) {
  const owners = t.routers.map((id) => sessions.get(id)).filter(isReachable);
  if (owners.length > 0) dispatch({ source: "agent", to: owners, target: t.title, text: p.text, deliver: `${unverifiedStamp(p)} In the board channel of your thread "${t.title}" (${t.id}): ${unforge(p.text)}${howToAnswer(p)}` });
}

// constraint: the board vouches only for the device, the profile is typed by the poster, so only a post this server recorded carries a yarn sender stamp
export function handOver(p: BoardPost): string {
  const record = sent[p.id];
  if (!record && inFlight.posts > 0) return "retry";
  if (record) {
    if (record.delivered) return "already delivered";
    deliverRecorded(p.id, record, "board");
    return "delivered";
  }
  const [, kind, id] = /^yarn\/(agent|thread)\/([\w-]+)$/.exec(p.channel) ?? [];
  if (kind === "agent") {
    const to = sessions.get(id ?? "");
    if (!to || !isReachable(to)) return "no such agent here";
    deliverToAgent(p, to);
    return "delivered unverified";
  }
  const t = kind === "thread" ? threads.find((x) => x.id === id && isOpen(x)) : undefined;
  if (!t) return "not a channel for this yarn";
  deliverToThread(p, t);
  return "handed to the thread owner unverified";
}

export async function readBoard(path: string, timeoutMs = POST_MS * 2): Promise<{ body: unknown } | { error: string }> {
  const url = boardUrl();
  if (url === undefined) return { error: `no board configured (${AGENT_BOARD_CONFIG} in yarn's state folder)` };
  try {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { error: `board answered ${String(res.status)}: ${(await res.text()).slice(0, 200)}` };
    const body: unknown = await res.json();
    return { body };
  } catch (error) {
    return { error: `board unreachable: ${String(error)}` };
  }
}

// constraint: who wrote a message is known only for what this server posted; the board's profile is the poster's own word
export const postedBy = (ids: string[]) => Object.fromEntries(ids.flatMap((id) => {
  const record = sent[id];
  if (!record) return [];
  return [[id, record.isIsaac ? "isaac" : (record.from ?? "yarn")]];
}));

const AGENT_CHANNEL = /^yarn\/agent\/([\w-]+)$/;
const isaacSaid = (id: string, channel: string, text: string) =>
  `[yarn · Isaac, on the agent board, message ${id} in ${channel}] ${text}\n[yarn] He wrote this in yarn's Board tab and reads the answer there: reply on the board with \`${CLI} board reply ${id} '<text>'\`.`;

export async function postAsIsaac(where: { channel: string } | { re: string; channel: string }, text: string): Promise<Carried> {
  recordIsaacSaid(text);
  const posted = await postToBoard({ ...where, text }, "isaac");
  if ("error" in posted) return { via: "direct", error: posted.error };
  const to = AGENT_CHANNEL.exec(where.channel)?.[1];
  const agent = sessions.get(to ?? "");
  const isForAnAgent = agent !== undefined && isReachable(agent);
  keep(posted.id, { ...(isForAnAgent && { to: agent.id, deliver: isaacSaid(posted.id, where.channel, text) }), text, at: Date.now(), delivered: !isForAnAgent, isIsaac: true });
  return { via: "board", id: posted.id };
}
