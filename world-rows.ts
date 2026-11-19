import { type Event, query } from "./bus";
import { DIR } from "./instance";
import { funnel, live_thread, waitLabel } from "./lifecycle";
import type { Message, Signal, Source, Task, Thread } from "./model";
import { SENTRY_USES } from "./sentry-uses";
import { type Session, type Wait, isAgent, isSentry, sessions } from "./sessions";
import { live, names, objectives, rememberNames, tasks, threads } from "./stores";
import { shells } from "./waits";
import { agentState, ghStatus, isFilled, isWaitingOnSomething, links, localIso, pendingOf, sentryTies, stateSince, status, taskRef, v2Status } from "./world-session";

const SENTRY_OUTPUT_ROUNDING_MS = 10_000;
const CONVERSATION_CONTEXT_MS = 2 * 3_600_000;
const UNROUTED = "unrouted";

function movedStub(t: Thread) {
  if (t.moved === undefined || t.parent !== undefined) return;
  const his = t.messages.find((m) => m.from === "isaac");
  if (his === undefined) return;
  const into = threads.find((x) => x.mergedInto === undefined && x.messages.some((m) => m.id === his.id)) ?? live_thread(t);
  if (into === undefined) return;
  return {
    id: t.id,
    title: t.title,
    objectiveId: into.objective,
    routerIds: [],
    ...(t.resolved && { resolved: { at: localIso(t.resolved.at) } }),
    movedTo: { id: into.id, title: into.title, objectiveId: into.objective, messageId: his.id, at: localIso(t.moved.at) },
    messages: [{ id: his.id, from: his.from, at: localIso(his.at), text: his.text }],
  };
}
const movedStubs = () => threads.map(movedStub).filter((stub) => stub !== undefined);

type WorldContext = { shown: Task[]; unrouted: Session[]; front: Session | undefined };

type AgentRow = {
  id: string;
  name: string;
  role: string;
  objectiveId: string;
  parent?: string;
  scope?: string;
  taskIds: string[];
  state: string;
  since?: string;
  doing: string;
  cwd: string;
  links: string[];
  wait: Wait | null;
};

function agentParent(s: Session, ctx: WorldContext): { parent?: string } {
  if (ctx.unrouted.includes(s)) return { parent: ctx.front?.id ?? UNROUTED };
  const parent = s.role?.parent;
  return isFilled(parent) ? { parent } : {};
}

function doingOf(s: Session) {
  if (!isWaitingOnSomething(s)) return s.name;
  return s.wait.kind === "until" ? `waiting until ${s.wait.desc}` : `waiting on ${waitLabel(s.wait)}`;
}

function agentRow(s: Session, ctx: WorldContext): AgentRow {
  const isUnrouted = ctx.unrouted.includes(s);
  const scope = s.role?.scope;
  return {
    id: s.id,
    name: s.name,
    role: !isUnrouted && s.role?.role === "router" ? "router" : "worker",
    objectiveId: isUnrouted ? UNROUTED : (s.role?.objective ?? UNROUTED),
    ...agentParent(s, ctx),
    ...(isFilled(scope) && { scope }),
    taskIds: ctx.shown.filter((t) => t.sessions.includes(s.id)).map((t) => taskRef(t.id)),
    state: agentState(s),
    since: localIso(stateSince(s)),
    doing: doingOf(s),
    cwd: s.cwd,
    links: links(s),
    wait: s.wait ?? null,
  };
}

function agentRows(agents: Session[], ctx: WorldContext): AgentRow[] {
  const out = agents.map((s) => agentRow(s, ctx));
  if (ctx.unrouted.length > 0) {
    const { front } = ctx;
    out.push({ id: front?.id ?? UNROUTED, name: "funnel", role: "router", objectiveId: UNROUTED, scope: "Not routed yet", taskIds: [], state: front ? agentState(front) : "idle", doing: "funnel", cwd: DIR, links: [], wait: null });
  }
  return out;
}

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
type Route = { at: number; routedTo: string[]; objective: string; kind?: string };

function deliveryState(s: Session | undefined, head: string) {
  if (!live(s)) return "gone";
  return s.inbox.some((t) => t.includes(head)) ? "queued" : "delivered";
}
const deliveryOf = (d: Signal, ids: string[]) => Object.fromEntries(ids.map((id) => [id, deliveryState(sessions.get(id), d.text.slice(0, 80))]));

const conversationOf = (d: Signal) => /^(.*\/archives\/D\w+)\//.exec(d.link ?? "")?.[1] ?? d.on;

function contextOf(d: Signal, external: Signal[]) {
  const conversation = conversationOf(d);
  const at = d.at ?? 0;
  return external
    .filter((x) => conversationOf(x) === conversation && (x.at ?? 0) < at && at - (x.at ?? 0) < CONVERSATION_CONTEXT_MS)
    .slice(-8)
    .map((x) => ({ who: x.who, at: localIso(x.at ?? 0), text: x.text, ...(x.own === true && { own: true }) }));
}

const linksTo = (d: Signal) => (taskLink: string) => {
  const link = taskLink.toLowerCase();
  return link === d.on?.toLowerCase() || d.link?.toLowerCase().startsWith(`${link}/`) === true;
};

function feedTaskOf(d: Signal) {
  const task = tasks.findLast((t) => t.links.some(linksTo(d)));
  const fed = task === undefined ? undefined : threads.find((t) => t.feed?.task === task.id && !isFilled(t.mergedInto));
  const on = [...new Set([...(fed?.routers ?? []), ...(task?.sessions ?? [])])];
  const fedObjective = fed?.objective;
  return { task, fed, on, objective: isFilled(fedObjective) ? fedObjective : task?.objective };
}

const externalHops = (d: Signal, at: string, on: string[], objective: string | undefined) => [
  ...(d.routedTo.length > 0 ? [{ at, to: d.routedTo }] : []),
  ...(on.length > 0 || isFilled(objective) ? [{ at, to: on, objective, routed: true }] : []),
];

function externalSignalRow(e: Event, d: Signal, external: Signal[]): SignalRow {
  const { task, fed, on, objective } = feedTaskOf(d);
  const at = localIso(d.at ?? e.at);
  const hops = externalHops(d, at, on, objective);
  const routedTo = [...new Set([...d.routedTo, ...on])];
  return {
    id: `s${e.seq}`,
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
    context: contextOf(d, external),
    ...(d.own === true && { own: true }),
    delivery: deliveryOf(d, [...new Set([...d.routedTo, ...on])]),
  };
}

function signalRow(e: Event, routes: Map<number, Route>, external: Signal[]): SignalRow {
  const d = e.data as Signal;
  if (d.event !== undefined) return externalSignalRow(e, d, external);
  const r = routes.get(e.seq);
  const route = [{ at: localIso(e.at), to: d.routedTo, objective: d.objective }, ...(r ? [{ at: localIso(r.at), to: r.routedTo, objective: r.objective, kind: r.kind, routed: true }] : [])];
  const thread = d.source === "isaac" ? threads.find((t) => t.messages.some((m) => m.from === "isaac" && m.text === d.text))?.id : undefined;
  return {
    id: `s${e.seq}`,
    seq: e.seq,
    source: d.source,
    at: localIso(e.at),
    target: d.target,
    text: d.text,
    from: d.from,
    routedTo: r ? [...d.routedTo, ...r.routedTo] : d.routedTo,
    objective: r?.objective ?? d.objective,
    route,
    thread,
    delivery: deliveryOf(d, [...d.routedTo, ...(r?.routedTo ?? [])]),
  };
}

function signalRows(events: Event[]) {
  const routes = new Map(
    events.filter((e) => e.topic.startsWith("signal-route/")).map((e) => [(e.data as { seq: number }).seq, { at: e.at, ...(e.data as { routedTo: string[]; objective: string; kind?: string }) }]),
  );
  const external = events.filter((e) => e.topic.startsWith("signal/") && (e.data as Signal).event !== undefined).map((e) => e.data as Signal);
  return events
    .filter((e) => e.topic.startsWith("signal/"))
    .slice(-500)
    .toReversed()
    .map((e) => signalRow(e, routes, external))
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function finalObjective(id: string | undefined): string | undefined {
  const merged = objectives.find((x) => x.id === id)?.mergedInto;
  return isFilled(merged) ? finalObjective(merged) : id;
}
const objectiveOfSignal = (sig: SignalRow) => finalObjective(sig.objective ?? sig.routedTo.map((id) => sessions.get(id)?.role?.objective).find(isFilled));

function fromKind(sig: SignalRow) {
  if (sig.source === "isaac") return "isaac";
  if (isFilled(sig.from) && sessions.get(sig.from)?.role?.role === "router") return "router";
  return sig.source === "agent" ? "agent" : "sentry";
}

function objectiveRows(signals: SignalRow[], ctx: WorldContext) {
  const os = objectives
    .filter((o) => o.closed !== true)
    .map((o) => ({
      id: o.id,
      title: o.title,
      cwd: o.cwd,
      taskIds: ctx.shown.filter((t) => t.objective === o.id).map((t) => taskRef(t.id)),
      events: signals
        .filter((sig) => objectiveOfSignal(sig) === o.id)
        .slice(0, 50)
        .toReversed()
        .map((sig) => ({ from: fromKind(sig), at: sig.at, text: sig.text })),
      page: o.page,
    }));
  if (ctx.unrouted.length > 0) os.push({ id: UNROUTED, title: "Unrouted", cwd: DIR, taskIds: [], events: [], page: [] });
  return os;
}

function prNumberOf(t: Task) {
  const n = Number(t.links.map((u) => /\/pull\/(\d+)/.exec(u)?.[1]).find(isFilled));
  return n === 0 || Number.isNaN(n) ? undefined : n;
}

function timelineFrom(session: string | undefined) {
  if (!isFilled(session)) return "sentry";
  return sessions.get(session)?.role?.role === "router" ? "router" : "agent";
}

const taskRow = (t: Task) => ({
  id: taskRef(t.id),
  title: t.title,
  status: v2Status(t),
  board: t.status,
  agent: t.sessions.at(-1),
  pr: prNumberOf(t),
  links: t.links,
  dependsOn: [],
  start: localIso(t.at),
  ...(t.status === "done" && { end: localIso(t.updated) }),
  events: t.timeline.map((e) => ({ from: timelineFrom(e.session), at: localIso(e.at), text: e.text })),
  page: t.page ?? [],
});

const asksOf = (t: Thread) =>
  t.asks && !t.paused && !t.resolved && { asks: { sessionId: t.asks.session, since: localIso(t.asks.since), shown: (t.asks.shown ?? 0) !== 0 } };

const pausedOf = (t: Thread) =>
  t.paused && { paused: { until: localIso(t.paused.until), at: localIso(t.paused.at), said: t.paused.said, posts: t.paused.posts ?? 0, ...(isFilled(t.paused.wake) && { wake: t.paused.wake }) } };

const messageRow = (m: Message) => ({ id: m.id, from: m.from, at: localIso(m.at), text: m.text, ...(m.nudge && { nudge: m.nudge }), ...(m.wake && { wake: true }), ...(m.ext && { ext: m.ext }) });

const threadRow = (t: Thread) => ({
  id: t.id,
  title: t.title,
  objectiveId: t.objective,
  ...(t.parent && { parentId: t.parent.thread, parentMessageId: t.parent.message }),
  routerIds: t.routers,
  pending: pendingOf(t.pending),
  ...asksOf(t),
  taskId: t.task === undefined ? undefined : taskRef(t.task),
  ...(t.resolved && { resolved: { at: localIso(t.resolved.at) } }),
  ...pausedOf(t),
  ...(t.resurfaced && { resurfaced: { at: localIso(t.resurfaced.at), from: t.resurfaced.from } }),
  ...(t.pinned && { pinned: { at: localIso(t.pinned.at), order: t.pinned.order } }),
  ...(t.feed && { feed: { source: t.feed.source, who: t.feed.who, link: t.feed.link } }),
  messages: t.messages.map(messageRow),
});

const roundedSentryOutputAt = (at: number) => Math.floor(at / SENTRY_OUTPUT_ROUNDING_MS) * SENTRY_OUTPUT_ROUNDING_MS;

const sentryRow = (s: Session) => ({
  id: s.id,
  name: s.name.replace(/^sentry:/, ""),
  running: live(s),
  agent: isAgent(s),
  status: status(s),
  lastOutputAt: roundedSentryOutputAt(s.lastOutputAt),
  createdAt: s.createdAt,
  ties: sentryTies[s.name]?.() ?? [],
  use: SENTRY_USES[s.name] ?? "",
});

function endedSessionNames() {
  rememberNames();
  return Object.fromEntries(Object.entries(names).filter(([id]) => !live(sessions.get(id))));
}

function worldContext() {
  const all = sessions
    .values()
    .filter((s) => s.role !== undefined || live(s))
    .toArray();
  const agents = all.filter((s) => isAgent(s) && !isSentry(s) && live(s));
  const unrouted = agents.filter((s) => {
    const objective = s.role?.objective;
    return objective === undefined || objectives.every((o) => o.id !== objective);
  });
  const ctx: WorldContext = { shown: tasks.filter((t) => t.status !== "dropped"), unrouted, front: funnel() };
  return { agents, ctx };
}

export async function world() {
  const { agents, ctx } = worldContext();
  const agentList = agentRows(agents, ctx);
  const signals = signalRows(await query("signal*/**", 0, 0));
  return {
    objectives: objectiveRows(signals, ctx),
    agents: agentList,
    tasks: ctx.shown.map(taskRow),
    threads: [...threads.filter((t) => !isFilled(t.mergedInto)).map(threadRow), ...movedStubs()],
    signals,
    sentries: sessions.values().filter(isSentry).map(sentryRow).toArray(),
    shells: shells.map(({ file: _, ...x }) => x),
    names: endedSessionNames(),
    prs: Object.fromEntries(Object.entries(ghStatus()).map(([key, { pr }]) => [key.toLowerCase(), { title: pr.title, state: pr.state.toLowerCase() }])),
  };
}
