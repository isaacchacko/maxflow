import { type Kept, type Msg, read, readMessages, short, splitTarget } from "../slack-read";
import type { DmConversation } from "./slack-places";

const KEEP = 50;
export const OWN_TIE_MS = Number(process.env["SLACK_OWN_TIE_MS"] ?? 2 * 86_400_000);
const DM_TIE_MS = Number(process.env["SLACK_DM_TIE_MS"] ?? 3 * 86_400_000);
const DM_READS = Number(process.env["SLACK_DM_READS"] ?? 8);
const time = () => new Date().toLocaleTimeString();

export type State = {
  latest: Record<string, string>;
  seen: Record<string, string[]>;
  titles: Record<string, string>;
  own: Record<string, number>;
  readAt: Record<string, number>;
  bots: string[];
  ownSeeded?: boolean;
  dms: Record<string, DmConversation>;
  groups: Record<string, string[]>;
  places: Record<string, string | null>;
  direct: string[];
};
export const state: State = { latest: {}, seen: {}, titles: {}, own: {}, readAt: {}, bots: [], dms: {}, groups: {}, places: {}, direct: [] };
export const memory: { kept?: Record<string, Kept>; publishedDirect?: Set<string> } = {};
export const liveDmsNewestFirst = () =>
  Object.entries(state.dms)
    .filter(([, d]) => Date.now() - d.at < DM_TIE_MS)
    .toSorted((a, b) => b[1].at - a[1].at)
    .slice(0, DM_READS)
    .map(([id]) => id);

function keep(target: string, title: string, msgs: Msg[]) {
  memory.kept ??= readMessages();
  const byTs = new Map([...(memory.kept[target]?.msgs ?? []), ...msgs].map((m) => [m.ts, m]));
  const { thread } = splitTarget(target);
  const all = byTs
    .values()
    .toArray()
    .toSorted((a, b) => Number(a.ts) - Number(b.ts));
  const parentKeptAlways = thread === undefined ? [] : all.filter((m) => m.ts === thread);
  memory.kept[target] = { at: Date.now(), title, msgs: [...parentKeptAlways, ...all.filter((m) => m.ts !== thread).slice(-KEEP)] };
}

async function freshSearchHits(target: string) {
  const previous = state.latest[target];
  const { msgs: hits, title } = await read(target);
  const seen = new Set(state.seen[target]);
  state.seen[target] = [...seen, ...hits.map((m) => m.ts)].slice(-500);
  state.latest[target] ??= "seen";
  keep(target, title, hits);
  return { msgs: previous === undefined ? [] : hits.filter((m) => !seen.has(m.ts)), title };
}

function advanceLatest(target: string, previous: string | undefined, newest: string | undefined) {
  if (newest !== undefined && (previous === undefined || Number(newest) > Number(previous))) state.latest[target] = newest;
  else state.latest[target] ??= (Date.now() / 1000).toFixed(6);
}

function conversationTitle(target: string, thread: string | undefined, name: string) {
  if (thread === undefined) return name;
  const parentTitle = state.titles[target];
  return `thread ${parentTitle === undefined || parentTitle === "" ? thread : `"${parentTitle}"`} in ${name}`;
}

async function freshConversation(target: string) {
  const previous = state.latest[target];
  const { thread } = splitTarget(target);
  const got = await read(target, previous);
  const parent = thread === undefined ? undefined : got.msgs.find((m) => m.ts === thread);
  if (parent) state.titles[target] = short(parent.text, 60);
  advanceLatest(target, previous, got.msgs.at(-1)?.ts);
  const title = conversationTitle(target, thread, got.name);
  keep(target, title, got.msgs);
  return { msgs: previous === undefined ? [] : got.msgs.filter((m) => Number(m.ts) > Number(previous) && m.ts !== thread), title };
}

export async function freshOrLogged(target: string): Promise<{ msgs: Msg[]; title: string } | undefined> {
  try {
    return await (target.startsWith("search:") ? freshSearchHits(target) : freshConversation(target));
  } catch (error) {
    console.error(`${time()}  ${target}: ${String(error)}`);
    return undefined;
  }
}

const THREAD_LINK = /archives\/(\w+)\/p(\d{10})(\d{6})(?:\?thread_ts=([\d.]+))?/;
export function threadTargetOfLink(link: string | undefined) {
  const match = link === undefined ? null : THREAD_LINK.exec(link);
  if (!match) return;
  const [, channel = "", seconds = "", micros = "", threadTs] = match;
  return `${channel}/${threadTs ?? `${seconds}.${micros}`}`;
}

export function seedOwnThreads(target: string, byAgent: Set<string>) {
  state.ownSeeded = true;
  const msgs = memory.kept?.[target]?.msgs ?? [];
  for (const m of msgs) {
    const at = byAgent.has(m.ts) ? undefined : threadTargetOfLink(m.link);
    if (at !== undefined && Date.now() - Number(m.ts) * 1000 < OWN_TIE_MS) state.own[at] = Math.max(state.own[at] ?? 0, Number(m.ts) * 1000);
  }
}

function learnGroupDm(me: string, m: Msg) {
  if (m.channel !== "a group DM" || m.members === undefined || m.members === "") return;
  const group = m.link === undefined ? undefined : /archives\/(\w+)/.exec(m.link)?.[1];
  if (group === undefined) return;
  state.groups[group] = m.members
    .matchAll(/([^,]+?) \(ID: (\w+)\)/g)
    .filter((x) => x[2] !== me)
    .map((x) => (x[1] ?? "").trim())
    .toArray();
}

function learnDm(me: string, m: Msg) {
  const dm = m.link === undefined ? undefined : /archives\/(D\w+)/.exec(m.link)?.[1];
  if (dm === undefined) return;
  const conversation = (state.dms[dm] ??= { who: "", at: 0 });
  conversation.at = Math.max(conversation.at, Number(m.ts) * 1000);
  const latest = state.latest[dm];
  if (latest === undefined || latest === "" || Number(latest) < Number(m.ts)) state.latest[dm] = m.ts;
  if (m.uid !== me) conversation.who = m.who;
}

export function learnConversationsFromSearch(me: string, target: string) {
  if (![`search:to:<@${me}>`, `search:from:<@${me}>`, `search:<@${me}>`].includes(target)) return;
  const msgs = memory.kept?.[target]?.msgs ?? [];
  for (const m of msgs) {
    learnGroupDm(me, m);
    learnDm(me, m);
  }
}

export function noteDmActivity(target: string, msgs: Msg[], me: string) {
  const dm = state.dms[target];
  if (!dm) return;
  const theirs = msgs.findLast((m) => m.uid !== me);
  if (theirs) dm.who = theirs.who;
  const newest = msgs.at(-1);
  if (newest) dm.at = Math.max(dm.at, Number(newest.ts) * 1000);
}

const onlyTied = <T>(record: Record<string, T>, isTied: (key: string) => boolean) => Object.fromEntries(Object.entries(record).filter(([key]) => isTied(key)));

export function forgetUntied(listeners: Map<string, Set<string>>) {
  const isTied = (key: string) => listeners.has(key);
  state.latest = onlyTied(state.latest, isTied);
  state.seen = onlyTied(state.seen, isTied);
  state.titles = onlyTied(state.titles, isTied);
  state.own = onlyTied(state.own, isTied);
  state.readAt = onlyTied(state.readAt, isTied);
  if (memory.kept) memory.kept = onlyTied(memory.kept, isTied);
}

