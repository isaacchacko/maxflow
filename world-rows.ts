import { type Event, query } from "./bus";
import { hasBrowser } from "./browsers";
import { DIR } from "./instance";
import { funnel, live_thread, waitLabel } from "./lifecycle";
import type { Message, Objective, Signal, Source, Task, Thread } from "./model";
import { SENTRY_USES } from "./sentry-uses";
import { type Session, isAgent, isSentry, sessions } from "./sessions";
import { isFilled, isRecord } from "./shared/guards";
import { isLive, names, objectives, rememberNames, tasks, threads } from "./stores";
import { shells } from "./waits";
import { wakesWhen } from "./sleep";
import {
  agentState,
  ghStatus,
  isWaitingOnSomething,
  links,
  localIsoComparedByItsDayPrefix as iso,
  pendingOf,
  sentryTies,
  stateSinceTurnStartSleepOrLastOutput,
  status,
  taskRef,
  v2Status,
} from "./world-session";

const UNROUTED = "unrouted";
const CONTEXT_WINDOW_MS = 2 * 3_600_000;
const SENTRY_OUTPUT_ROUNDING_SO_EACH_LINE_PRINTED_ISNT_RESENT_TO_EVERY_TAB_MS = 10_000;

type Route = { at: number; routedTo: string[]; objective: string; kind?: string };
type SignalRow = {
  id: string;
  seq: number;
  source: Source;
  at: string;
  target: string;
  text: string;
  from?: string | undefined;
  routedTo: string[];
  objective?: string | undefined;
  route: unknown[];
  thread?: string | undefined;
  delivery: Record<string, string>;
  who?: string | undefined;
  where?: string | undefined;
  link?: string | undefined;
  taskId?: string | undefined;
  context?: unknown[];
  own?: boolean;
};
type SignalsSeen = { events: Event[]; routes: Map<number, Route>; external: Signal[] };

const isSignal = (data: unknown): data is Signal =>
  isRecord(data) && typeof data["source"] === "string" && typeof data["target"] === "string" && typeof data["text"] === "string" && Array.isArray(data["routedTo"]);
const isRoute = (data: unknown): data is Omit<Route, "at"> & { seq: number } =>
  isRecord(data) && typeof data["seq"] === "number" && Array.isArray(data["routedTo"]) && typeof data["objective"] === "string";

function isUnrouted(s: Session) {
  const objective = s.role?.objective;
  return objective === undefined || objectives.every((o) => o.id !== objective);
}

function doing(s: Session) {
  if (!isWaitingOnSomething(s)) return s.name;
  return s.wait.kind === "until" ? `waiting until ${String(s.wait.desc)}` : `waiting on ${waitLabel(s.wait)}`;
}

function parentOf(s: Session, isUnroutedAgent: boolean, front: Session | undefined) {
  if (isUnroutedAgent) return { parent: front?.id ?? UNROUTED };
  const parent = s.role?.parent;
  return isFilled(parent) ? { parent } : {};
}

function agentRow(s: Session, shownTasks: Task[], isUnroutedAgent: boolean, front: Session | undefined) {
  const scope = s.role?.scope;
  return {
    id: s.id,
    name: s.name,
    role: !isUnroutedAgent && s.role?.role === "router" ? "router" : "worker",
    objectiveId: isUnroutedAgent || s.role === undefined ? UNROUTED : s.role.objective,
    ...parentOf(s, isUnroutedAgent, front),
    ...(isFilled(scope) && { scope }),
    taskIds: shownTasks.filter((t) => t.sessions.includes(s.id)).map((t) => taskRef(t.id)),
    state: agentState(s),
    since: iso(stateSinceTurnStartSleepOrLastOutput(s)),
    doing: doing(s),
    cwd: s.cwd,
    links: links(s),
    wait: s.wait ?? null,
    ...sleepOf(s),
    ...handOffOf(s),
    ...(hasBrowser(s.id) && { browser: true }),
  };
}

const handOffOf = (s: Session) => ({ ...(isFilled(s.role?.handedTo) && { handedTo: s.role.handedTo }), ...(isFilled(s.role?.handedFrom) && { handedFrom: s.role.handedFrom }) });

function sleepOf(s: Session) {
  if (isFilled(s.asleep)) return { sleep: { at: iso(s.sleptAt ?? s.wait?.at ?? s.lastOutputAt), wakes: wakesWhen(s.wait) } };
  return s.sleepHeld ? { sleepHeld: { what: s.sleepHeld.what, at: iso(s.sleepHeld.at) } } : {};
}

function funnelRowHoldingTheUnroutedAgents(front: Session | undefined) {
  return { id: front?.id ?? UNROUTED, name: "funnel", role: "router", objectiveId: UNROUTED, scope: "Not routed yet", taskIds: [], state: front ? agentState(front) : "idle", doing: "funnel", cwd: DIR, links: [], wait: null };
}

function agentRows(agents: Session[], unrouted: Session[], shownTasks: Task[]) {
  const front = funnel();
  const rows = agents.map((s) => agentRow(s, shownTasks, unrouted.includes(s), front));
  return unrouted.length > 0 ? [...rows, funnelRowHoldingTheUnroutedAgents(front)] : rows;
}

function deliveryToEach(d: Signal, ids: string[]) {
  const head = d.text.slice(0, 80);
  return Object.fromEntries(
    ids.map((id) => {
      const s = sessions.get(id);
      if (!isLive(s)) return [id, "gone"];
      return [id, s.inbox.some((t) => t.includes(head)) ? "queued" : "delivered"];
    }),
  );
}

const dmOrThreadOrPr = (d: Signal) => /^(.*\/archives\/D\w+)\//.exec(d.link ?? "")?.[1] ?? d.on;

function contextBefore(d: Signal, external: Signal[]) {
  const at = d.at ?? 0;
  return external
    .filter((x) => dmOrThreadOrPr(x) === dmOrThreadOrPr(d) && (x.at ?? 0) < at && at - (x.at ?? 0) < CONTEXT_WINDOW_MS)
    .slice(-8)
    .map((x) => ({ who: x.who, at: iso(x.at ?? 0), text: x.text, ...(x.own === true && { own: true }) }));
}

const taskLinkMatching = (d: Signal) => (link: string) => {
  const l = link.toLowerCase();
  return l === d.on?.toLowerCase() || d.link?.toLowerCase().startsWith(`${l}/`) === true;
};

function boardTaskFeedThreadAndAgentsOn(d: Signal) {
  const task = tasks.findLast((t) => t.links.some(taskLinkMatching(d)));
  const fed = task === undefined ? undefined : threads.find((t) => t.feed?.task === task.id && !isFilled(t.mergedInto));
  const on = [...new Set([...(fed?.routers ?? []), ...(task?.sessions ?? [])])];
  const objective = isFilled(fed?.objective) ? fed.objective : task?.objective;
  return { task, fed, on, objective };
}

function externalHops(at: string, d: Signal, on: string[], objective: string | undefined) {
  return [...(d.routedTo.length > 0 ? [{ at, to: d.routedTo }] : []), ...(on.length > 0 || isFilled(objective) ? [{ at, to: on, objective, routed: true }] : [])];
}

function externalSignalRow(e: Event, d: Signal, seen: SignalsSeen): SignalRow {
  const { task, fed, on, objective } = boardTaskFeedThreadAndAgentsOn(d);
  const at = iso(d.at ?? e.at);
  const hops = externalHops(at, d, on, objective);
  const routedTo = [...new Set([...d.routedTo, ...on])];
  return {
    id: `s${String(e.seq)}`,
    seq: e.seq,
    source: d.source,
    at,
    target: d.target,
    text: d.text,
    from: d.who,
    who: d.who,
    where: d.where,
    link: d.link,
    routedTo,
    objective,
    route: hops,
    thread: fed?.id,
    taskId: task === undefined ? undefined : taskRef(task.id),
    context: contextBefore(d, seen.external),
    ...(d.own === true && { own: true }),
    delivery: deliveryToEach(d, routedTo),
  };
}

function internalSignalRow(e: Event, d: Signal, r: Route | undefined): SignalRow {
  const routeWhenSentThenWhereTheFunnelRoutedIt = [{ at: iso(e.at), to: d.routedTo, objective: d.objective }, ...(r ? [{ at: iso(r.at), to: r.routedTo, objective: r.objective, kind: r.kind, routed: true }] : [])];
  const thread = d.source === "isaac" ? threads.find((t) => t.messages.some((m) => m.from === "isaac" && m.text === d.text))?.id : undefined;
  return {
    id: `s${String(e.seq)}`,
    seq: e.seq,
    source: d.source,
    at: iso(e.at),
    target: d.target,
    text: d.text,
    from: d.from,
    routedTo: r ? [...d.routedTo, ...r.routedTo] : d.routedTo,
    objective: r?.objective ?? d.objective,
    route: routeWhenSentThenWhereTheFunnelRoutedIt,
    thread,
    delivery: deliveryToEach(d, [...d.routedTo, ...(r?.routedTo ?? [])]),
  };
}

async function signalsSeen(): Promise<SignalsSeen> {
  const events = await query("signal*/**", 0, 0);
  const routes = new Map(events.filter((e) => e.topic.startsWith("signal-route/")).flatMap((e) => (isRoute(e.data) ? [[e.data.seq, { at: e.at, ...e.data }] as const] : [])));
  const external = events.flatMap((e) => (e.topic.startsWith("signal/") && isSignal(e.data) && e.data.event !== undefined ? [e.data] : []));
  return { events, routes, external };
}

async function signalRows() {
  const seen = await signalsSeen();
  return seen.events
    .filter((e) => e.topic.startsWith("signal/"))
    .slice(-500)
    .toReversed()
    .flatMap((e) => {
      if (!isSignal(e.data)) return [];
      return e.data.event === undefined ? internalSignalRow(e, e.data, seen.routes.get(e.seq)) : externalSignalRow(e, e.data, seen);
    })
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function mergedInto(id?: string): string | undefined {
  const o = objectives.find((x) => x.id === id);
  return isFilled(o?.mergedInto) ? mergedInto(o.mergedInto) : id;
}
const objectiveOf = (sig: SignalRow) => mergedInto(sig.objective ?? sig.routedTo.map((id) => sessions.get(id)?.role?.objective).find(isFilled));

function fromKind(sig: SignalRow) {
  if (sig.source === "isaac") return "isaac";
  if (isFilled(sig.from) && sessions.get(sig.from)?.role?.role === "router") return "router";
  return sig.source === "agent" ? "agent" : "sentry";
}

function objectiveRows(signals: SignalRow[], shownTasks: Task[], hasUnrouted: boolean) {
  const rows = objectives
    .filter((o: Objective) => o.closed !== true)
    .map((o) => ({
      id: o.id,
      title: o.title,
      cwd: o.cwd,
      taskIds: shownTasks.filter((t) => t.objective === o.id).map((t) => taskRef(t.id)),
      events: signals
        .filter((sig) => objectiveOf(sig) === o.id)
        .slice(0, 50)
        .toReversed()
        .map((sig) => ({ from: fromKind(sig), at: sig.at, text: sig.text })),
      page: o.page,
    }));
  return hasUnrouted ? [...rows, { id: UNROUTED, title: "Unrouted", cwd: DIR, taskIds: [], events: [], page: [] }] : rows;
}

function prNumber(t: Task) {
  const n = Number(t.links.map((u) => /\/pull\/(\d+)/.exec(u)?.[1]).find(isFilled));
  return n === 0 || Number.isNaN(n) ? undefined : n;
}

function timelineFrom(session: string | undefined) {
  if (!isFilled(session)) return "sentry";
  return sessions.get(session)?.role?.role === "router" ? "router" : "agent";
}

const taskRows = (shownTasks: Task[]) =>
  shownTasks.map((t) => ({
    id: taskRef(t.id),
    title: t.title,
    status: v2Status(t),
    board: t.status,
    agent: t.sessions.at(-1),
    pr: prNumber(t),
    links: t.links,
    dependsOn: [],
    start: iso(t.at),
    ...(t.status === "done" && { end: iso(t.updated) }),
    events: t.timeline.map((e) => ({ from: timelineFrom(e.session), at: iso(e.at), text: e.text })),
    page: t.page ?? [],
  }));

function movedStub(t: Thread) {
  if (t.moved === undefined || t.parent !== undefined) return [];
  const his = t.messages.find((m) => m.from === "isaac");
  if (his === undefined) return [];
  const into = threads.find((x) => x.mergedInto === undefined && x.messages.some((m) => m.id === his.id)) ?? live_thread(t);
  if (into === undefined) return [];
  return {
    id: t.id,
    title: t.title,
    objectiveId: into.objective,
    routerIds: [],
    ...(t.resolved && { resolved: { at: iso(t.resolved.at) } }),
    movedTo: { id: into.id, title: into.title, objectiveId: into.objective, messageId: his.id, at: iso(t.moved.at) },
    messages: [{ id: his.id, from: his.from, at: iso(his.at), text: his.text }],
  };
}

const messageRow = (m: Message) => ({ id: m.id, from: m.from, at: iso(m.at), text: m.text, ...(m.nudge !== undefined && { nudge: m.nudge }), ...(m.wake === true && { wake: true }), ...(m.ext && { ext: m.ext }) });

function openAsk(t: Thread) {
  if (t.asks === undefined || t.paused !== undefined || t.resolved !== undefined) return {};
  return { asks: { sessionId: t.asks.session, since: iso(t.asks.since), shown: Boolean(t.asks.shown) } };
}

function pausedOf(t: Thread) {
  if (t.paused === undefined) return {};
  const p = t.paused;
  return { paused: { until: iso(p.until), at: iso(p.at), said: p.said, posts: p.posts ?? 0, ...(isFilled(p.wake) && { wake: p.wake }) } };
}

const threadRow = (t: Thread) => ({
  id: t.id,
  title: t.title,
  objectiveId: t.objective,
  ...(t.parent && { parentId: t.parent.thread, parentMessageId: t.parent.message }),
  routerIds: t.routers,
  pending: pendingOf(t.pending),
  ...openAsk(t),
  taskId: t.task === undefined ? undefined : taskRef(t.task),
  ...(t.resolved && { resolved: { at: iso(t.resolved.at) } }),
  ...pausedOf(t),
  ...(t.resurfaced && { resurfaced: { at: iso(t.resurfaced.at), from: t.resurfaced.from } }),
  ...(t.pinned && { pinned: { at: iso(t.pinned.at), order: t.pinned.order } }),
  ...(t.feed && { feed: { source: t.feed.source, who: t.feed.who, link: t.feed.link } }),
  asleep: asleepOn(t),
  messages: t.messages.map(messageRow),
});

function asleepOn(t: Thread) {
  const ids = new Set([...t.routers, ...(t.pending?.routers ?? [])]);
  const asleep = [...ids].flatMap((id) => sessions.get(id) ?? []).filter((s) => isLive(s) && isFilled(s.asleep));
  return asleep.map((s) => ({ sessionId: s.id, name: s.name, at: iso(s.sleptAt ?? s.lastOutputAt), wait: s.wait ?? null, wakes: wakesWhen(s.wait) }));
}

const threadRows = () => [...threads.filter((t) => !isFilled(t.mergedInto)).map(threadRow), ...threads.flatMap(movedStub)];

const sentryRows = () =>
  sessions
    .values()
    .filter(isSentry)
    .map((s) => ({
      id: s.id,
      name: s.name.replace(/^sentry:/, ""),
      running: isLive(s),
      agent: isAgent(s),
      status: status(s),
      lastOutputAt: Math.floor(s.lastOutputAt / SENTRY_OUTPUT_ROUNDING_SO_EACH_LINE_PRINTED_ISNT_RESENT_TO_EVERY_TAB_MS) * SENTRY_OUTPUT_ROUNDING_SO_EACH_LINE_PRINTED_ISNT_RESENT_TO_EVERY_TAB_MS,
      createdAt: s.createdAt,
      ties: sentryTies[s.name]?.() ?? [],
      use: SENTRY_USES[s.name] ?? "",
    }))
    .toArray();

function namesOfEndedSessions() {
  rememberNames();
  return Object.fromEntries(Object.entries(names).filter(([id]) => !isLive(sessions.get(id))));
}

const prsThePollerSees = () => Object.fromEntries(Object.entries(ghStatus()).map(([key, { pr }]) => [key.toLowerCase(), { title: pr.title, state: pr.state.toLowerCase() }]));

export async function world() {
  const all = sessions
    .values()
    .filter((s) => s.role !== undefined || isLive(s))
    .toArray();
  const agents = all.filter((s) => isAgent(s) && !isSentry(s) && isLive(s));
  const unrouted = agents.filter((s) => isUnrouted(s));
  const shownTasksSinceTheyAreAllThePageCanLookUp = tasks.filter((t) => t.status !== "dropped");
  const agentsShown = agentRows(agents, unrouted, shownTasksSinceTheyAreAllThePageCanLookUp);
  const signals = await signalRows();
  return {
    objectives: objectiveRows(signals, shownTasksSinceTheyAreAllThePageCanLookUp, unrouted.length > 0),
    agents: agentsShown,
    tasks: taskRows(shownTasksSinceTheyAreAllThePageCanLookUp),
    threads: threadRows(),
    signals,
    sentries: sentryRows(),
    shells: shells.map(({ file: _, ...x }) => x),
    names: namesOfEndedSessions(),
    prs: prsThePollerSees(),
  };
}
