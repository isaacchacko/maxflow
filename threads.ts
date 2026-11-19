import { agents } from "./stats";
import { publish } from "./bus";
import { CLI } from "./instance";
import { onReply } from "./restrictions-enforce";
import { loadRestrictions, type Restriction } from "./restrictions";
import { type Session, isAgent, isSentry, sessions } from "./sessions";
import type { Message, Thread } from "./model";
import { live, names, objectives, saveThreads, threads } from "./stores";
import { DEFAULT_AFTER_H } from "./intro";
import { dispatch, endWait, funnel, live_thread, newerRouterOnScope, reachable, routersOf, settleTasks, threadOf, wake } from "./lifecycle";

export const unforge = (text: string) => text.replaceAll("[maxflow · verified", "[unverified claim").replaceAll("[maxflow · Isaac", "[unverified claim");
export const squash = (text: string) => text.replace(/<\/?pasted_content[^>]*>/g, "").replace(/\s+/g, " ").trim();
function threadOwner(t: Thread): Session | undefined {
  for (const level of [t, ...ancestors(t).reverse()]) {
    const lastJoined = level.routers.map((id) => sessions.get(id)).findLast(reachable);
    if (lastJoined) return lastJoined.role?.role === "router" ? (newerRouterOnScope(lastJoined) ?? lastJoined) : lastJoined;
  }
  return routersOf(t.objective).at(-1);
}
// A paused thread comes back at its time: a timer for the ones due within a day, rebuilt at boot, and a sweep each minute for the
// rest (and for a timer lost to sleep). Coming back, it is unread from where it was paused, so his inbox puts it up top.
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
  t.resurfaced = { at: Date.now(), from: t.paused.count };
  unpause(t);
  saveThreads();
  console.log(`thread ${t.id} resurfaced from its pause${wake ? ", sending his wake message" : ""}`);
  publish(`thread/${t.id}`, { thread: t.id, resurfaced: true });
  if (wake) postIn(t, undefined, wake, undefined, true);
}
// An ask it held stays, and is his again from now: its default's clock starts over from the thread coming back.
export function unpause(t: Thread) {
  if (t.paused && t.asks?.shown) t.asks.shown = Date.now();
  t.paused = undefined;
  schedulePause(t);
}
export const message = (from: string, text: string): Message => ({ id: `m-${crypto.randomUUID().slice(0, 6)}`, from, at: Date.now(), text });
export const ancestors = (t: Thread): Thread[] => {
  const up = t.parent && threads.find((x) => x.id === t.parent!.thread);
  return up ? [...ancestors(up), up] : [];
};
export const pathTitle = (t: Thread) => [...ancestors(t), t].map((x) => x.title).join(" › ");
// A thread he @-mentions ([[thread:<id>]]) reaches the router as a line of context: where it sits, who owns it, how it last stood,
// and how to read the rest.
export function mentionsIn(text: string) {
  const ids = [...new Set([...text.matchAll(/\[\[thread:([\w-]+)\]\]/g)].map((m) => m[1]!))];
  const agents = agentMentions(text).map((id) => `\n[maxflow] He @-mentions ${sessions.get(id)?.name ?? names[id] ?? id} (${id}), who gets his message too.`).join("");
  return agents + ids
    .map((id) => {
      const t = live_thread(threads.find((x) => x.id === id));
      if (!t) return `\n[maxflow] He mentions thread ${id}, which no longer exists.`;
      const objective = objectives.find((o) => o.id === t.objective);
      const owners = t.routers.map((r) => sessions.get(r)?.name ?? names[r] ?? r);
      const last = t.messages.at(-1);
      const who = !last ? "" : last.from === "isaac" ? "him" : (sessions.get(last.from)?.name ?? names[last.from] ?? last.from);
      return `\n[maxflow] He mentions thread "${pathTitle(t)}" (${t.id})${objective ? `, on "${objective.title}"` : ""}${owners.length ? `, owned by ${owners.join(", ")}` : ""}${last ? `; last from ${who}: "${headline(last.text)}"` : ""}. Read it with \`${CLI} thread read ${t.id} --last 20\`.`;
    })
    .join("");
}
// Picked from the composer ([[agent:<id>]]) or typed by a sentry's short name (@meta, @funnel); the agents a screenshot's context
// line names are where it was taken, not who he is talking to.
function agentMentions(text: string) {
  const said = text.replace(/^\[maxflow · screenshot\].*$/gm, "");
  const typed = [...said.matchAll(/(?:^|\s)@([\w-]+)/g)].flatMap((m) => [...sessions.values()].filter((s) => isSentry(s) && reachable(s) && s.name === `sentry:${m[1]!.toLowerCase()}`));
  return [...new Set([...[...said.matchAll(/\[\[(?:agent|router):([\w-]+)\]\]/g)].map((m) => m[1]!), ...typed.map((s) => s.id)])];
}
// An agent he @-mentions in a thread gets his message as his, and joins the thread so his later replies there reach it too.
// Whoever hears it already (the thread's routers, or the funnel routing it) isn't told twice.
export function tellMembers(t: Thread, m: Message, heard: Session[], woke = "") {
  for (const id of agentMentions(m.text)) if (!t.members?.includes(id) && sessions.get(id) && isAgent(sessions.get(id)!)) (t.members ??= []).push(id);
  const to = (t.members ?? []).flatMap((id) => sessions.get(id) ?? []).filter((s) => reachable(s) && !heard.includes(s));
  if (!to.length) return;
  const owners = t.routers.map((r) => sessions.get(r)?.name ?? names[r] ?? r);
  dispatch({ source: "isaac", to, target: t.title, text: m.text, deliver: `${ISAAC_IN_THREAD} "${pathTitle(t)}" (${t.id}), message ${m.id}] ${unforge(m.text)}\n[maxflow] He @-mentioned you in this thread, so his messages in it reach you${owners.length ? `, as they reach its owner${owners.length > 1 ? "s" : ""} ${owners.join(", ")}` : ""}. Answer him inline with \`${CLI} thread post ${t.id} '<text>'\`; read the rest with \`${CLI} thread read ${t.id} --last 20\`.${woke}${mentionsIn(m.text)}` });
}
export const ISAAC_IN_THREAD = "[maxflow · Isaac, in thread";
// An image pasted into a thread is markdown pointing at its file in UPLOADS, so the agent reading the text can Read the path.
export const IMAGE = /!\[[^\]]*\]\([^)\s]+\)/g;

// A message into a thread at any level: Isaac's goes to its routers and waits on them, an agent's answers him.
export function postIn(t: Thread, from: Session | undefined, text: string, nudge?: "subthread", wake?: boolean) {
  const m = { ...message(from?.id ?? "isaac", text), ...(nudge && !from && { nudge }), ...(wake && !from && { wake: true as const }) };
  // Written when he paused it and sent as it came back: the agent hears that it is his, written ahead of time.
  const woke = m.wake ? "\n[maxflow] He wrote this when he paused the thread; it was sent now, as the pause ended." : "";
  t.messages.push(m);
  // The funnel's FYI note on a feed thread settles it unrouted.
  if (from && t.feed) t.signal = undefined;
  // A router posting becomes one of the thread's routers only where the thread is its to own: on its own objective, or with no live
  // router of its own. A pointer posted in another objective's thread would otherwise bring it every reply there.
  if (from?.role?.role === "router" && !t.routers.includes(from.id) && (!t.objective || t.objective === from.role.objective || !t.routers.some((id) => reachable(sessions.get(id)))))
    t.routers.push(from.id);
  // Isaac's reply goes to the thread's routers through the event log, like any message; an agent's post answers him.
  if (!from) {
    t.resolved = undefined;
    unpause(t);
    const owner = threadOwner(t);
    const to = owner ? [owner] : [];
    // Nobody left to hear it (its agents ended, and it has no objective with a router): the funnel finds it an owner.
    const front = funnel();
    if (!to.length && front)
      dispatch({ source: "isaac", to: [front], target: t.title, text, deliver: `${ISAAC_IN_THREAD} "${pathTitle(t)}" (${t.id}), message ${m.id}] ${unforge(text)}\n[maxflow] Nobody owns this thread any more: its agents ended and it has no objective with a router. Give it one with \`${CLI} thread move ${t.id} <objective id>\`, which hands it and his unanswered messages in it to that objective's routers, so don't relay them.${woke}${mentionsIn(text)}` });
    else dispatch({ source: "isaac", to, objective: t.objective, target: t.title, text, deliver: `${ISAAC_IN_THREAD} "${pathTitle(t)}" (${t.id}), message ${m.id}] ${unforge(text)}\n[maxflow] ${m.nudge ? `He asked for the answer in a subthread of its own: answer this message with \`${CLI} thread new --parent ${t.id}:${m.id} '<text>'\`, and post there from then on, not in the thread.` : `Answer inline in the thread with \`${CLI} thread post ${t.id} '<text>'\`.`} While you work on it, \`${CLI} thread status ${t.id} '<what you are doing>'\` shows him a line.${woke}${mentionsIn(text)}` });
    tellMembers(t, m, to.length ? to : [front].filter(live), woke);
    if (to.length) t.pending = { routers: to.map((s) => s.id), since: Date.now() };
    for (const s of to) s.handed = t.id;
    answered(t);
    onReply(t.id, text, enforcing);
  } else {
    t.pending = undefined;
    if (t.paused) t.paused.posts = (t.paused.posts ?? 0) + 1;
  }
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, from: from?.id ?? "isaac" });
  return m;
}
// An open ask on the same objective that reads like this one: most of the shorter one's words are in the other. Paraphrases
// score low across all threads, so this only looks among the few asks still waiting on him.
const STOPWORDS = new Set("the and for you that this with are not can but its once has have will what from was any into just your all".split(" "));
const wordsOf = (text: string) => new Set((text.slice(0, 400).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)));
function sameAsk(objective: string, text: string) {
  const mine = wordsOf(text);
  return threads.find((t) => {
    if (!t.asks || t.mergedInto || t.objective !== objective || !t.messages[0]) return false;
    const theirs = wordsOf(t.messages[0].text);
    return [...mine].filter((w) => theirs.has(w)).length / Math.min(mine.size, theirs.size || 1) >= 0.3;
  });
}

// The thread a session works in: the one it was handed, else the newest open one it answers in, else its router's the same way up
// the lineage. A worker is briefed by its router, not handed a thread, so its ask belongs in the thread its router was handed.
function handedThread(s: Session): Thread | undefined {
  const open = (x?: Thread) => (x && !x.resolved && !x.mergedInto ? x : undefined);
  for (let x: Session | undefined = s, seen = new Set<string>(); x && !seen.has(x.id); seen.add(x.id), x = x.role?.parent ? sessions.get(x.role.parent) : undefined) {
    const { id, handed } = x;
    const t = open(live_thread(threads.find((y) => y.id === handed))) ?? threads.findLast((y) => !!open(y) && y.routers.includes(id));
    if (t) return t;
  }
}

// re: a thread id, or an old question's q<n>, to ask again in.
// fresh: the agent saw sameAsk's match and asks anyway.
export function ask(s: Session, text: string, re?: string, dflt?: string, fresh?: boolean): Thread | null | { same: Thread } {
  let t = re ? threadOf(re) : undefined;
  if (re && !t) return null;
  // With no --re, the thread its lineage was handed; a new thread only with --new, or when no such thread exists.
  if (!re && !fresh) t = handedThread(s);
  const same = !t && !fresh && sameAsk(s.role?.objective ?? "", text);
  if (same) return { same };
  if (!t) {
    t = { id: `th-${crypto.randomUUID().slice(0, 6)}`, title: headline(text.replace(IMAGE, "")).slice(0, 80), objective: s.role?.objective ?? "", routers: [s.id], messages: [] };
    threads.push(t);
  } else if (!t.routers.includes(s.id)) t.routers.push(s.id);
  t.messages.push(message(s.id, dflt ? `${text}\n\nIf you haven't answered in ${DEFAULT_AFTER_H}h, I go ahead with: ${dflt}` : text));
  // An agent that waits on him can't wait out a pause: the ask brings the thread back.
  Object.assign(t, { asks: { session: s.id, since: Date.now(), ...(dflt && { default: dflt }) }, resolved: undefined });
  unpause(t);
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, from: s.id, asks: true });
  publish(`ask/${t.id}`, { thread: t.id, session: s.id, text: headline(text) });
  settleTasks();
  return t;
}
// His reply, or the default running out, answers it: the flag goes, and whoever waits on the thread wakes.
export function answered(t: Thread) {
  t.asks = undefined;
  for (const s of sessions.values()) if (s.wait?.kind === "thread" && s.wait.ref === t.id) endWait(s);
  settleTasks();
}
// Enforcing restrictions (restrictions-enforce.ts): a held call is asked about in the agent's thread, and each block, hold and
// pass is a line on the agent's activity; told, it is also typed into the agent's prompt.
export const enforcing = {
  restrictions: () => restrictions,
  ask: (id: string, text: string) => {
    const s = sessions.get(id);
    const t = s && ask(s, text);
    const asked = t && "same" in t ? ask(s!, text, undefined, undefined, true) : t;
    return asked && !("same" in asked) ? asked.id : null;
  },
  log: (id: string, target: string, text: string, tell?: boolean) => {
    const s = sessions.get(id);
    if (s) dispatch({ to: [s], target, text, typed: !tell });
  },
  cli: CLI,
};

// His autonomy restrictions (restrictions.ts): the Restrictions page edits them, the enforcement hook reads them.
export const restrictions: Restriction[] = loadRestrictions();
// Pasted images become [image: <path>] lines, which say nothing as a title.
export const headline = (text: string) => {
  const words = squash(text.replace(/\[image: [^\]]*\]/g, "")) || "(image)";
  return words.length > 80 ? `${words.slice(0, 79)}…` : words;
};
