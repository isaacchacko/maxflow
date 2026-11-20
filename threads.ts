import { callerOf, FORGEABLE_STAMPS, SCREENSHOT_STAMP } from "./shared/legacy-maxflow";
import { publish } from "./bus";
import { CLI } from "./instance";
import { onReply } from "./restrictions-enforce";
import { loadRestrictions, type Restriction } from "./restrictions";
import { type Session, isAgent, isSentry, sessions } from "./sessions";
import type { Message, Thread } from "./model";
import { isLive, names, objectives, saveThreads, threads } from "./stores";
import { DEFAULT_AFTER_H } from "./intro";
import { patch } from "./patch";
import { isFilled } from "./shared/guards";
import { dispatch, endWait, funnel, live_thread, newerRouterOnScope, isReachable, routersOf, settleTasks, threadOf } from "./lifecycle";

export const unforge = (text: string) => FORGEABLE_STAMPS.reduce((said, stamp) => said.replaceAll(stamp, "[unverified claim"), text);
export const squash = (text: string) => text.replaceAll(/<\/?pasted_content[^>]*>/g, "").replaceAll(/\s+/g, " ").trim();
function threadOwner(t: Thread): Session | undefined {
  for (const level of [t, ...ancestors(t).toReversed()]) {
    const lastJoined = level.routers.map((id) => sessions.get(id)).findLast(isReachable);
    if (lastJoined) return lastJoined.role?.role === "router" ? (newerRouterOnScope(lastJoined) ?? lastJoined) : lastJoined;
  }
  return routersOf(t.objective).at(-1);
}
const PAUSE_TIMER_MS = 86_400_000;
export const pauseTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function schedulePause(t: Thread) {
  clearTimeout(pauseTimers.get(t.id));
  pauseTimers.delete(t.id);
  const left = t.paused && t.paused.until - Date.now();
  if (left !== undefined && left < PAUSE_TIMER_MS) pauseTimers.set(t.id, setTimeout(() => resurface(t), Math.max(0, left)));
}
export function resurface(t: Thread) {
  if (!t.paused) return;
  const wake = t.paused.wake;
  patch(t, { resurfaced: { at: Date.now(), from: t.paused.count } });
  unpause(t);
  saveThreads();
  console.log(`thread ${t.id} resurfaced from its pause${isFilled(wake) ? ", sending his wake message" : ""}`);
  publish(`thread/${t.id}`, { thread: t.id, resurfaced: true });
  if (isFilled(wake)) postMessage(t, { text: wake, isWakeMessage: true });
}
export function unpause(t: Thread) {
  if (t.paused && t.asks?.shown !== undefined && t.asks.shown !== 0) patch(t.asks, { shown: Date.now() });
  patch(t, { paused: undefined });
  schedulePause(t);
}
export const message = (from: string, text: string): Message => ({ id: `m-${crypto.randomUUID().slice(0, 6)}`, from, at: Date.now(), text });
export const ancestors = (t: Thread): Thread[] => {
  const parentId = t.parent?.thread;
  const up = parentId === undefined ? undefined : threads.find((x) => x.id === parentId);
  return up ? [...ancestors(up), up] : [];
};
export const pathTitle = (t: Thread) => [...ancestors(t), t].map((x) => x.title).join(" › ");
const nameOf = (id: string) => sessions.get(id)?.name ?? names[id] ?? id;
const lastSpeaker = (last: Message) => (last.from === "isaac" ? "him" : nameOf(last.from));
function threadMentionLine(id: string) {
  const t = live_thread(threads.find((x) => x.id === id));
  if (!t) return `\n[yarn] He mentions thread ${id}, which no longer exists.`;
  const objective = objectives.find((o) => o.id === t.objective);
  const owners = t.routers.map(nameOf);
  const last = t.messages.at(-1);
  return `\n[yarn] He mentions thread "${pathTitle(t)}" (${t.id})${objective ? `, on "${objective.title}"` : ""}${owners.length > 0 ? `, owned by ${owners.join(", ")}` : ""}${last ? `; last from ${lastSpeaker(last)}: "${headline(last.text)}"` : ""}. Read it with \`${CLI} thread read ${t.id} --last 20\`.`;
}
export function mentionsIn(text: string) {
  const ids = [...new Set(text.matchAll(/\[\[thread:([\w-]+)\]\]/g).map((m) => m[1] ?? ""))];
  const agents = agentMentions(text).map((id) => `\n[yarn] He @-mentions ${nameOf(id)} (${id}), who gets his message too.`).join("");
  return agents + ids.map(threadMentionLine).join("");
}
const sentriesTypedAs = (typed: string) =>
  sessions.values().filter((s) => isSentry(s) && isReachable(s) && s.name === `sentry:${typed.toLowerCase()}`).toArray();
function agentMentions(text: string) {
  const saidOutsideScreenshotContext = text.replaceAll(SCREENSHOT_STAMP, "");
  const typed = saidOutsideScreenshotContext.matchAll(/(?:^|\s)@([\w-]+)/g).flatMap((m) => sentriesTypedAs(m[1] ?? "")).toArray();
  const picked = saidOutsideScreenshotContext.matchAll(/\[\[(?:agent|router):([\w-]+)\]\]/g).map((m) => m[1] ?? "");
  return [...new Set([...picked, ...typed.map((s) => s.id)])];
}
function joinMentionedAgents(t: Thread, text: string) {
  for (const id of agentMentions(text)) {
    const agent = sessions.get(id);
    if (!agent || t.members?.includes(id) === true || !isAgent(agent)) continue;
    if (t.members === undefined) patch(t, { members: [id] });
    else t.members.push(id);
  }
}
export function tellMembers(t: Thread, m: Message, heard: Session[], woke = "") {
  joinMentionedAgents(t, m.text);
  const to = (t.members ?? []).flatMap((id) => sessions.get(id) ?? []).filter((s) => isReachable(s) && !heard.includes(s));
  if (to.length === 0) return;
  const owners = t.routers.map(nameOf);
  const asTheyReachOwners = owners.length > 0 ? `, as they reach its owner${owners.length > 1 ? "s" : ""} ${owners.join(", ")}` : "";
  dispatch({ source: "isaac", to, target: t.title, text: m.text, deliver: `${ISAAC_IN_THREAD} "${pathTitle(t)}" (${t.id}), message ${m.id}] ${unforge(m.text)}\n[yarn] He @-mentioned you in this thread, so his messages in it reach you${asTheyReachOwners}. Answer him inline with \`${CLI} thread post ${t.id} '<text>'\`; read the rest with \`${CLI} thread read ${t.id} --last 20\`.${woke}${mentionsIn(m.text)}` });
}
export const ISAAC_IN_THREAD = "[yarn · Isaac, in thread";
export const IMAGE = /!\[[^\]]*\]\([^)\s]+\)/g;

type Post = { from?: Session | undefined; outsideLabel?: string; text: string; nudge?: "subthread" | undefined; isWakeMessage?: boolean };
const isHisPost = (post: Post) => post.from === undefined && post.outsideLabel === undefined;
function tellFunnelNobodyOwns(t: Thread, m: Message, woke: string, front: Session) {
  dispatch({ source: "isaac", to: [front], target: t.title, text: m.text, deliver: `${ISAAC_IN_THREAD} "${pathTitle(t)}" (${t.id}), message ${m.id}] ${unforge(m.text)}\n[yarn] Nobody owns this thread any more: its agents ended and it has no objective with a router. Give it one with \`${CLI} thread move ${t.id} <objective id>\`, which hands it and his unanswered messages in it to that objective's routers, so don't relay them.${woke}${mentionsIn(m.text)}` });
}
function handToOwner(t: Thread, m: Message, woke: string, to: Session[]) {
  const howToAnswer = m.nudge
    ? `He asked for the answer in a subthread of its own: answer this message with \`${CLI} thread new --parent ${t.id}:${m.id} '<text>'\`, and post there from then on, not in the thread.`
    : `Answer inline in the thread with \`${CLI} thread post ${t.id} '<text>'\`.`;
  dispatch({ source: "isaac", to, objective: t.objective, target: t.title, text: m.text, deliver: `${ISAAC_IN_THREAD} "${pathTitle(t)}" (${t.id}), message ${m.id}] ${unforge(m.text)}\n[yarn] ${howToAnswer} While you work on it, \`${CLI} thread status ${t.id} '<what you are doing>'\` shows him a line.${woke}${mentionsIn(m.text)}` });
}
function handHisPost(t: Thread, m: Message, woke: string) {
  patch(t, { resolved: undefined });
  unpause(t);
  const owner = threadOwner(t);
  const to = owner ? [owner] : [];
  const front = funnel();
  if (front && to.length === 0) tellFunnelNobodyOwns(t, m, woke, front);
  else handToOwner(t, m, woke, to);
  tellMembers(t, m, to.length > 0 ? to : [front].filter(isLive), woke);
  if (to.length > 0) patch(t, { pending: { routers: to.map((s) => s.id), since: Date.now() } });
  for (const s of to) s.handed = t.id;
  answered(t);
  onReply(t.id, m.text, enforcing);
}
function joinAsRouterWhereTheThreadIsItsToOwn(t: Thread, from: Session) {
  if (from.role?.role !== "router" || t.routers.includes(from.id)) return;
  if (t.objective === "" || t.objective === from.role.objective || t.routers.every((id) => !isReachable(sessions.get(id)))) t.routers.push(from.id);
}
function postedMessage(post: Post): Message {
  const { from, outsideLabel, text, nudge, isWakeMessage = false } = post;
  const isHis = isHisPost(post);
  return { ...message(from?.id ?? outsideLabel ?? "isaac", text), ...(nudge && isHis && { nudge }), ...(isWakeMessage && isHis && { wake: true as const }) };
}
function postMessage(t: Thread, post: Post) {
  const { from } = post;
  const m = postedMessage(post);
  const woke = m.wake ? "\n[yarn] He wrote this when he paused the thread; it was sent now, as the pause ended." : "";
  t.messages.push(m);
  if (!isHisPost(post) && t.feed) patch(t, { signal: undefined });
  if (from) joinAsRouterWhereTheThreadIsItsToOwn(t, from);
  if (isHisPost(post)) handHisPost(t, m, woke);
  else {
    patch(t, { pending: undefined });
    if (t.paused) patch(t.paused, { posts: (t.paused.posts ?? 0) + 1 });
  }
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, from: m.from });
  return m;
}
export const postIn = (t: Thread, from: Session | string | undefined, text: string, nudge?: "subthread") =>
  postMessage(t, typeof from === "string" ? { outsideLabel: from, text, nudge } : { from, text, nudge });
export function sessionless(req: Request, as: string | undefined): { label: string } | { isaac: true } | { refusal: string } {
  if (as !== undefined) return /^[\w.-]+\/[\w.-]+$/.test(as) ? { label: as } : { refusal: `--as takes <device>/<name>, like cleopatra/yarn-browser, not "${as}"` };
  const claimed = callerOf(req);
  if (claimed === "" && req.headers.get("sec-fetch-site") === "same-origin") return { isaac: true };
  const unknown = claimed === "" ? "No YARN_SESSION came with this post" : `YARN_SESSION=${claimed} is no live session`;
  return { refusal: `${unknown}, and only Isaac's browser posts as him. Set YARN_SESSION to your yarn session id, or post as --as <device>/<name>.` };
}
const STOPWORDS = new Set("the and for you that this with are not can but its once has have will what from was any into just your all".split(" "));
const wordsOf = (text: string) => new Set((text.slice(0, 400).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)));
function sameAsk(objective: string, text: string) {
  const mine = wordsOf(text);
  return threads.find((t) => {
    if (!t.asks || isFilled(t.mergedInto) || t.objective !== objective || !t.messages[0]) return false;
    const theirs = wordsOf(t.messages[0].text);
    return [...mine].filter((w) => theirs.has(w)).length / Math.min(mine.size, theirs.size === 0 ? 1 : theirs.size) >= 0.3;
  });
}

const openThread = (x?: Thread) => (x && !x.resolved && !isFilled(x.mergedInto) ? x : undefined);
function lineage(s: Session) {
  const seen = new Set<string>();
  const line: Session[] = [];
  for (let x: Session | undefined = s; x && !seen.has(x.id); ) {
    seen.add(x.id);
    line.push(x);
    const parent: string | undefined = x.role?.parent;
    x = isFilled(parent) ? sessions.get(parent) : undefined;
  }
  return line;
}
function handedThread(s: Session): Thread | undefined {
  for (const { id, handed } of lineage(s)) {
    const t = openThread(live_thread(threads.find((y) => y.id === handed))) ?? threads.findLast((y) => openThread(y) !== undefined && y.routers.includes(id));
    if (t) return t;
  }
  return undefined;
}
function threadToAskIn(s: Session, text: string, re: string | undefined, isFresh: boolean): Thread | null | { same: Thread } | undefined {
  if (isFilled(re)) return threadOf(re) ?? null;
  if (isFresh) return undefined;
  const handed = handedThread(s);
  if (handed) return handed;
  const same = sameAsk(s.role?.objective ?? "", text);
  return same ? { same } : undefined;
}
function newAskThread(s: Session, text: string) {
  const t: Thread = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: headline(text.replaceAll(IMAGE, "")).slice(0, 80), objective: s.role?.objective ?? "", routers: [s.id], messages: [] };
  threads.push(t);
  return t;
}
type AskOptions = { re?: string | undefined; dflt?: string | undefined; isFresh?: boolean | undefined };
export function ask(s: Session, text: string, { re, dflt, isFresh }: AskOptions = {}): Thread | null | { same: Thread } {
  const found = threadToAskIn(s, text, re, isFresh === true);
  if (found === null || (found !== undefined && "same" in found)) return found;
  const t = found ?? newAskThread(s, text);
  if (!t.routers.includes(s.id)) t.routers.push(s.id);
  t.messages.push(message(s.id, isFilled(dflt) ? `${text}\n\nIf you haven't answered in ${DEFAULT_AFTER_H}h, I go ahead with: ${dflt}` : text));
  patch(t, { asks: { session: s.id, since: Date.now(), ...(isFilled(dflt) && { default: dflt }) }, resolved: undefined });
  unpause(t);
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, from: s.id, asks: true });
  publish(`ask/${t.id}`, { thread: t.id, session: s.id, text: headline(text) });
  settleTasks();
  return t;
}
export function answered(t: Thread) {
  patch(t, { asks: undefined });
  for (const s of sessions.values()) if (s.wait?.kind === "thread" && s.wait.ref === t.id) endWait(s);
  settleTasks();
}
export const enforcing = {
  restrictions: () => restrictions,
  ask: (id: string, text: string) => {
    const s = sessions.get(id);
    if (!s) return null;
    const first = ask(s, text);
    const asked = first && "same" in first ? ask(s, text, { isFresh: true }) : first;
    return asked && !("same" in asked) ? asked.id : null;
  },
  log: (id: string, target: string, text: string, shouldTell?: boolean) => {
    const s = sessions.get(id);
    if (s) dispatch({ to: [s], target, text, typed: shouldTell !== true });
  },
  cli: CLI,
};

export const restrictions: Restriction[] = loadRestrictions();
export const headline = (text: string) => {
  const words = squash(text.replaceAll(/\[image: [^\]]*\]/g, "")) || "(image)";
  return words.length > 80 ? `${words.slice(0, 79)}…` : words;
};
