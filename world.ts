import type { ServerWebSocket } from "bun";
import { ghStatusTable, peekStateJson, stateDisplayPath, watchedStateFile } from "./state";
import { onPublish, query } from "./bus";
import { CLI, DIR } from "./instance";
import { type Session, type WsData, chatOf, isAgent, isSentry, sessions } from "./sessions";
import { candidates } from "./mentions";
import type { GhPr, Pending, Signal, Source, Task } from "./model";
import { live, names, objectives, rememberNames, tasks, threads } from "./stores";
import { VERIFIED } from "./intro";
import { funnel, live_thread, reachable, waitLabel } from "./lifecycle";
import { shells } from "./waits";
import { BLOCKED_SHOWN_MS, activeAt } from "./delivery";
import { DOCS_DIR } from "./docs";

// What an agent linked to each sentry in the graph is told about it.
export const SENTRY_USES: Record<string, string> = {
  "sentry:docs": `It watches Isaac's docs vault (${DOCS_DIR}, markdown he edits in Obsidian): it git-commits every edit once the vault has been quiet 15s, and wakes a doc's owner (the \`owner:\` session id in its frontmatter) when he leaves a comment there that nobody has answered, else the funnel. A message starting \`[maxflow docs]\` is from it.`,
  "sentry:jev": `It shadows the funnel: for each request of the user's that the funnel sizes or routes, it asks a Jev typed-decision model the same question (the request's size, and which open objective or new) and logs Jev's pick beside the funnel's in ${stateDisplayPath("jev-shadow.jsonl")}. It never routes anything; agents can ignore it.`,
  "sentry:gh": `It polls GitHub every 30s for the PRs tied to a session and notifies that session when CI finishes, a review or comment lands (the user's own comments included), or the PR merges, closes or conflicts. A PR whose branch is checked out in your folder is tied to you already; tie any other with \`${CLI} gh watch <pr>\` (url, owner/repo#n or n). For a PR's CI, failed and pending checks, reviews and unresolved threads, run \`${CLI} gh status [pr]\` instead of \`gh pr checks\` or \`gh pr view\`: it answers from the sentry's last poll, with no GitHub call, and with no PR covers every one you're tied to. To block on one event instead: \`${CLI} sub 'gh/<owner>/<repo>/pr/<n>/ci'\`.`,
  "sentry:slack": `It polls Slack every minute for the threads, channels and searches tied to a session and notifies that session of each new message. A thread you posted in through the Slack connector is tied to you already, for 3 days after your last post; tie any other with \`${CLI} slack watch <permalink | channel id | #channel | search query>\`. To read a thread, channel or search, run \`${CLI} slack read <same> [--last N]\` instead of the Slack connector's read tools: it answers from the sentry's last poll and ties you to what you read. It also publishes every mention of the user as slack/mention: block on one with \`${CLI} sub 'slack/mention'\`, or on a thread with \`${CLI} sub 'slack/<channel>/<thread ts>/reply'\`.`,
  "sentry:inbox": `It turns what reaches the user on Slack and GitHub that no session heard (mentions of him, DMs to him, replies in threads he posted in, comments and reviews on PRs requesting his review) into tasks on his board, hands a Slack reply to the chat that posted in its thread, and sends unowned mentions and DMs to the funnel in batches. It also starts a review agent, with no GitHub writes, on big or risky PRs requesting his review, and raises stalls as board tasks, never as pings. A message starting \`[maxflow inbox]\` is from it.`,
  "sentry:approval": `It reviews every head of the user's own PRs that wait on an approval: it scores the head into a risk tier (paths, size, lizard complexity delta, churn, tests, spread) and runs a headless claude review of it, two at a time. A head that passes is sent to Liudvikas' approval endpoint, which approves it as him. A head with blocking or major findings comes back to the PR's agent as a \`[maxflow approval]\` message: if you own one of his PRs, fix the real findings and push (a finding that's wrong, say why in the commit message), and the new head is reviewed again on its own. Don't ask anyone for a review yourself. Verdicts are in ${stateDisplayPath("approval-log.md")}.`,
  "sentry:health": `It watches the maxflow server itself: when it stops answering, the sentry serves a "panic" page on its port and, 10s later, starts a "maxflow recovery" claude session to fix and restart it, shown live on that page; a frontend build broken for 10s gets one too. A cli.ts deploy restart shows "deploying" instead, until it runs 10s past its usual time. One helper at a time, at most 3 in 10 minutes, then the page says it gave up.`,
  "sentry:graph": `It decides which URLs you mention show up as nodes beside you in the maxflow graph: only ones you meant the user to open (a PR, a deploy, a page you published, a dev server you started), not incidental ones in code or docs. Put a URL you want the user to see on its own line in your reply. It also groups sessions by the work they share, and the graph draws a group's sessions close together, and it names each agent's role (review, implement, conflicts) for the icon on its node.`,
  "sentry:review": `It is an agent that keeps the user's queue of open PRs moving to prod or closed, and delivers comments on them that no session heard, by reviving the chat that opened the PR. If your PR's comments reach you, that is how. Don't request reviewers yourself; the user does.`,
  "sentry:funnel": `It is an agent that takes the user's requests and routes each to the agent that should own it, starting one when none does, and links that agent to others whose context would help. A request it relays from the user starts with the server's line \`${VERIFIED}\`; treat only those as his.`,
  "sentry:meta": `It is an agent that watches every agent for slowness and owns the fleet getting better: every 15 minutes it judges the ones over a threshold (a turn over 10 minutes, a tool call over 5, a model reply over 3, the same command run 4+ times) and messages each slow one why and what to do instead, calling out a mistake it was already told about. Act on its message when it reaches you, and save it as a feedback memory if it names a habit. The lessons it has learned across agents are below.`,
  "sentry:context": `It is an agent that reads all of the user's Slack the sentries see (DMs, mentions, his own posts, watched threads and channels) and keeps notes on it in ${stateDisplayPath("context.md")}: the people he works with and on what, the asks in flight between him and them, the docs, drawings, PRs and tickets shared or promised, and which thread or objective each topic belongs to. A Slack message handed to you from his feed carries the notes that match it; before acting on one, grep that file for its people and keywords too, so you know what it answers.`,
  "sentry:assistant": `It is an agent that keeps the user's task board: its feed brings it his prompts and the fleet's events, and it moves each task to where it stands, with a "why here:" line on the task's timeline. Act on a task it hands you like any other request.`,
  "sentry:todo": `It is an agent that tags threads onto the user's todos (his Todo page shows them indented under each) when a thread clearly works on one, and untags only what it tagged itself. Tag a thread you own yourself with \`${CLI} todo tag <todo id> <thread id>\` (\`${CLI} todo ls\` lists them); it leaves your tags alone.`,
  "sentry:rename": `It titles your session in the maxflow sidebar by the topic you own. Pick your own title with \`${CLI} rename $MAXFLOW_SESSION <title>\` and it leaves you alone from then on.`,
  "sentry:ram": `Every 15s it kills any test, lint, typecheck or build job an agent runs locally once its process tree holds over 1.5% of the machine's RAM, and tells that agent to run it on the Blacksmith CI runners by pushing to its PR. Run those through CI from the start: push, then \`gh pr checks\`.`,
};

// Without hooks a session counts as working while it prints; hooked claude says so itself, checked against two blind spots:
// an Esc interrupt fires no hook (the spinner animates nonstop while working, so silence means it stopped),
// and a permission dialog answered "no" fires none either (any redraw after the dialog means it was answered).
const BUSY_MS = 4000, SPINNER_GAP_MS = 10_000, DIALOG_SETTLE_MS = 2000;
function status(s: Session) {
  if (s.exitCode !== null) return "exited";
  if (isSentry(s)) return "idle";
  // With its claude stopped (asleep) or gone from the process table, an agent's pane prints only a placeholder: never working.
  if (s.asleep || (s.claudeUp === false && (s.cmd[0] === "claude" || !!chatOf(s)))) return "idle";
  const quiet = Date.now() - s.lastOutputAt;
  if (!s.claude) return quiet < BUSY_MS ? "working" : "idle";
  if (s.claude.state === "working") return quiet < SPINNER_GAP_MS ? "working" : "idle";
  if (s.claude.state === "waiting") return s.lastOutputAt > s.claude.at + DIALOG_SETTLE_MS ? "idle" : "waiting";
  return "idle";
}

// Its verdicts, { session: { url: keep } }; a URL it has not judged yet stays hidden.
const verdicts = watchedStateFile<Record<string, Record<string, boolean>>>("graph-links.json", {});
export const judged = (s: Session) => candidates(s).filter((c) => verdicts()[s.id]?.[c.url]).map((c) => c.url);
// A PR GitHub says doesn't exist, usually a bare #n resolved against the wrong repo, is never shown.
export const links = (s: Session) => judged(s).filter((u) => prStates.get(u) !== "missing");
export const prStates = new Map<string, string>();
// Links archived from the graph, by URL across every session; the graph greys them out or hides them with archived sessions.
export const ARCHIVED_LINKS = "archived-links.json";
export const archivedLinks = new Set<string>((() => { try { return (peekStateJson(ARCHIVED_LINKS) as string[] | undefined) ?? []; } catch { return []; } })());
// Its grouping of sessions by the work they share, { session: group }.
const groups = watchedStateFile<Record<string, string>>("graph-groups.json", {});
// Its reading of each agent's role, { session: "review" | "implement" | "conflicts" | null }.
const roles = watchedStateFile<Record<string, string | null>>("graph-roles.json", {});
// sentry:review's edges to the sessions on PRs waiting for a reviewer, [{ session, label }].
// Each sentry's edges to the sessions it is tied to, [{ session, label }], from <name>-edges.json.
const sentryTies = Object.fromEntries(["review", "gh", "slack"].map((n) => [`sentry:${n}`, watchedStateFile<{ session: string; label: string; prs?: string[] }[]>(`${n}-edges.json`, [])]));
function movedStubs() {
  const stubs = [];
  for (const t of threads) {
    if (t.moved === undefined || t.parent !== undefined) continue;
    const his = t.messages.find((m) => m.from === "isaac");
    if (his === undefined) continue;
    const into = threads.find((x) => x.mergedInto === undefined && x.messages.some((m) => m.id === his.id)) ?? live_thread(t);
    if (into === undefined) continue;
    stubs.push({ id: t.id, title: t.title, objectiveId: into.objective, routerIds: [], ...(t.resolved && { resolved: { at: iso(t.resolved.at) } }), movedTo: { id: into.id, title: into.title, objectiveId: into.objective, messageId: his.id, at: iso(t.moved.at) }, messages: [{ id: his.id, from: his.from, at: iso(his.at), text: his.text }] });
  }
  return stubs;
}
// A pending thread goes stale once no router it waits on is working or has the message still queued, past a grace for delivery.
const PENDING_GRACE_MS = 30_000;
// A shell can't be on it, however many messages wait in its inbox, so its thread goes stale instead of thinking for hours.
const onIt = (s?: Session) => reachable(s) && (s.inbox.length > 0 || agentState(s) === "working");
const pendingOf = (p?: Pending) => p && { routerIds: p.routers, since: iso(p.since), status: p.status, stale: Date.now() - p.since > PENDING_GRACE_MS && !p.routers.some((id) => onIt(sessions.get(id))) };
export const ghStatus = () => ghStatusTable.fresh() as Record<string, { pr: GhPr }>;

export const describe = (s: Session, shown = links(s)) => ({
  id: s.id,
  name: s.name,
  cmd: s.cmd,
  cwd: s.cwd,
  createdAt: s.createdAt,
  lastOutputAt: s.lastOutputAt,
  activeAt: activeAt(s),
  clients: s.clients.size,
  running: s.exitCode === null,
  exitCode: s.exitCode,
  chatId: s.chatId,
  transcript: s.transcript,
  pending: s.inbox.length,
  status: status(s),
  agent: isAgent(s),
  links: shown,
  archivedLinks: shown.filter((u) => archivedLinks.has(u)),
  prs: Object.fromEntries(shown.flatMap((u) => (prStates.has(u) ? [[u, prStates.get(u)]] : []))),
  group: groups()[s.id] ?? null,
  role: roles()[s.id] ?? null,
  archived: !!s.archived,
  asleep: !!s.asleep,
  sentry: isSentry(s),
  ties: (isSentry(s) && sentryTies[s.name]?.()) || [],
  wait: s.wait ?? null,
  role: s.role ?? null,
  blocked: s.inbox.length && s.blockedSince && Date.now() - s.blockedSince >= BLOCKED_SHOWN_MS ? { count: s.inbox.length, since: s.blockedSince } : null,
});

// Everything the UI draws, in its own shapes: objectives with their routers and workers, the signals routed to them, threads, tasks and sentries.
const UNROUTED = "unrouted";
function agentState(s: Session) {
  if (s.archived || s.asleep) return s.wait && s.wait.kind !== "done" ? "waiting" : "asleep";
  const st = status(s);
  return st === "working" || st === "waiting" ? st : s.wait && s.wait.kind !== "done" ? "waiting" : "idle";
}
// When an agent's state began, as near as the session knows: its turn's start while working, when it went to sleep on what it
// waits on, else its last output.
function stateSince(s: Session) {
  if (s.wait && s.wait.kind !== "done" && agentState(s) !== "working") return s.wait.at;
  if (s.claude && s.claude.state === agentState(s)) return s.claude.at;
  return s.lastOutputAt;
}
const taskRef = (id: number) => `t${id}`;
const v2Status = (t: Task) => (t.status === "todo" ? "todo" : t.status === "doing" ? "doing" : t.status === "done" || t.status === "dropped" ? "done" : "review");
// Local wall-clock time, which the UI compares by its first ten characters for "today".
const iso = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

// The world is built once and shared, not once per request: every open tab polled it every 1.5s, at 1.3MB and up to half a second
// a build. A build follows a bus event (most changes publish one) within ~100ms, at most one every 300ms, and every 2s while a tab
// follows it, for what changes without an event (an agent's state, read from its screen and the clock). Each build is diffed against the
// last by entity, and the tabs following it get only what changed; GET answers from the last build, 304 when the tab has it.
type World = Awaited<ReturnType<typeof world>>;
const COLLECTIONS = ["objectives", "agents", "tasks", "threads", "signals", "sentries"] as const;
type Built = { v: number; at: number; w: World; json?: string; items: Record<string, Map<string, string>>; order: Record<string, string>; rest: Record<string, string> };
export let built: Built | undefined;
let worldDirty = true, building: Promise<Built> | undefined, worldTimer: ReturnType<typeof setTimeout> | undefined, lastBuildAt = 0;
export const worldClients = new Set<ServerWebSocket<WsData>>();
function rebuildWorld(): Promise<Built> {
  if (building) return building;
  worldDirty = false;
  lastBuildAt = Date.now();
  building = (async () => {
    const w = await world();
    const items: Built["items"] = {}, order: Built["order"] = {}, rest: Built["rest"] = {};
    const upsert: Record<string, unknown[]> = {}, remove: Record<string, string[]> = {}, orders: Record<string, string[]> = {}, set: Record<string, unknown> = {};
    for (const c of COLLECTIONS) {
      const list = w[c] as { id: string }[];
      const m = new Map(list.map((x) => [String(x.id), JSON.stringify(x)]));
      items[c] = m;
      order[c] = [...m.keys()].join("\n");
      if (!built) continue;
      const prev = built.items[c]!;
      const up = list.filter((x) => prev.get(String(x.id)) !== m.get(String(x.id)));
      const gone = [...prev.keys()].filter((id) => !m.has(id));
      if (up.length) upsert[c] = up;
      if (gone.length) remove[c] = gone;
      if (order[c] !== built.order[c]) orders[c] = [...m.keys()];
    }
    for (const [k, val] of Object.entries(w)) {
      if ((COLLECTIONS as readonly string[]).includes(k)) continue;
      rest[k] = JSON.stringify(val);
      if (built && rest[k] !== built.rest[k]) set[k] = val;
    }
    const changed = !built || [upsert, remove, orders, set].some((o) => Object.keys(o).length);
    if (!changed) return Object.assign(built!, { at: Date.now() });
    const from = built?.v;
    built = { v: (from ?? 0) + 1, at: Date.now(), w, items, order, rest };
    if (from !== undefined && worldClients.size) {
      const msg = JSON.stringify({ type: "patch", from, v: built.v, upsert, remove, order: orders, set });
      for (const ws of worldClients) ws.sendText(msg);
    }
    return built;
  })().finally(() => {
    building = undefined;
    if (worldDirty) scheduleWorld();
  });
  return building;
}
function scheduleWorld() {
  if (worldTimer || !worldClients.size) return;
  worldTimer = setTimeout(() => ((worldTimer = undefined), void rebuildWorld()), Math.max(100, lastBuildAt + 300 - Date.now()));
}
// GET's world: the last build when nothing happened since it and it is under a second old, else a new one.
export async function freshWorld() {
  if (building) await building;
  return built && !worldDirty && Date.now() - built.at < 1000 ? built : rebuildWorld();
}
onPublish.add(() => ((worldDirty = true), scheduleWorld()));
setInterval(() => worldClients.size && Date.now() - lastBuildAt >= 2000 && void rebuildWorld(), 500);
export async function openWorld(ws: ServerWebSocket<WsData>) {
  worldClients.add(ws);
  const b = await freshWorld();
  if (ws.readyState === 1) ws.sendText(JSON.stringify({ type: "world", v: b.v, world: b.w }));
}

async function world() {
  const all = [...sessions.values()].filter((s) => live(s) || s.role);
  const agents = all.filter((s) => isAgent(s) && !isSentry(s) && live(s));
  const unrouted = agents.filter((s) => !s.role || !objectives.some((o) => o.id === s.role!.objective));
  const front = funnel();
  // A dropped task isn't sent, so no objective or agent may name one: the page looks each name up in the tasks sent.
  const shown = tasks.filter((t) => t.status !== "dropped");
  const taskIdsOf = (s: Session) => shown.filter((t) => t.sessions.includes(s.id)).map((t) => taskRef(t.id));
  const agentOf = (s: Session) => ({
    id: s.id,
    name: s.name,
    role: s.role?.role === "router" && !unrouted.includes(s) ? "router" : "worker",
    objectiveId: unrouted.includes(s) ? UNROUTED : s.role!.objective,
    ...(unrouted.includes(s) ? { parent: front?.id ?? UNROUTED } : s.role?.parent ? { parent: s.role.parent } : {}),
    ...(s.role?.scope && { scope: s.role.scope }),
    taskIds: taskIdsOf(s),
    state: agentState(s),
    since: iso(stateSince(s)),
    doing: s.wait && s.wait.kind !== "done" ? (s.wait.kind === "until" ? `waiting until ${s.wait.desc}` : `waiting on ${waitLabel(s.wait)}`) : s.name,
    cwd: s.cwd,
    links: links(s),
    wait: s.wait ?? null,
  });
  const out = agents.map(agentOf);
  // Agents nobody routed sit under the funnel, the router of everything not yet routed.
  if (unrouted.length) out.push({ id: front?.id ?? UNROUTED, name: "funnel", role: "router", objectiveId: UNROUTED, scope: "Not routed yet", taskIds: [], state: front ? agentState(front) : "idle", doing: "funnel", cwd: DIR, links: [], wait: null });

  const events = await query("signal*/**", 0, 0);
  const routes = new Map(events.filter((e) => e.topic.startsWith("signal-route/")).map((e) => [(e.data as { seq: number }).seq, { at: e.at, ...(e.data as { routedTo: string[]; objective: string; kind?: string }) }]));
  // Whether each recipient has it: still queued in its inbox, typed into its prompt, or its session is gone.
  const delivery = (d: Signal, ids: string[]) => Object.fromEntries(ids.map((id) => {
    const s = sessions.get(id);
    const head = d.text.slice(0, 80);
    return [id, !s || !live(s) ? "gone" : s.inbox.some((t) => t.includes(head)) ? "queued" : "delivered"];
  }));
  // An external message's conversation: a DM as a whole (each message there is its own Slack thread), else its thread or PR. The
  // drawer shows what came before it there in the last 2h, his own posts included.
  const convOf = (d: Signal) => d.link?.match(/^(.*\/archives\/D\w+)\//)?.[1] ?? d.on;
  const external = events.filter((e) => e.topic.startsWith("signal/") && (e.data as Signal).event !== undefined).map((e) => e.data as Signal);
  const contextOf = (d: Signal) => external.filter((x) => convOf(x) === convOf(d) && (x.at ?? 0) < (d.at ?? 0) && (d.at ?? 0) - (x.at ?? 0) < 2 * 3_600_000).slice(-8)
    .map((x) => ({ who: x.who, at: iso(x.at ?? 0), text: x.text, ...(x.own && { own: true }) }));
  const signals = events.filter((e) => e.topic.startsWith("signal/")).slice(-500).reverse().map((e) => {
    const d = e.data as Signal;
    const r = routes.get(e.seq);
    // The route in steps: where it went when sent (the funnel, an objective's routers, named sessions), then where the funnel routed it.
    const route = [{ at: iso(e.at), to: d.routedTo, objective: d.objective }, ...(r ? [{ at: iso(r.at), to: r.routedTo, objective: r.objective, kind: r.kind, routed: true }] : [])];
    // An external message goes on through the board task its thread or PR is on, the feed thread made for that task, and the agents on either.
    if (d.event !== undefined) {
      // A DM's task links the DM itself, a thread's the thread, a PR's the PR.
      const task = tasks.findLast((t) => t.links.some((l) => (l = l.toLowerCase()) === d.on?.toLowerCase() || !!d.link?.toLowerCase().startsWith(`${l}/`)));
      const fed = task && threads.find((t) => t.feed?.task === task.id && !t.mergedInto);
      const on = [...new Set([...(fed?.routers ?? []), ...(task?.sessions ?? [])])];
      const objective = fed?.objective || task?.objective;
      const hops = [...(d.routedTo.length ? [{ at: iso(d.at ?? e.at), to: d.routedTo }] : []), ...(on.length || objective ? [{ at: iso(d.at ?? e.at), to: on, objective, routed: true }] : [])];
      return { id: `s${e.seq}`, seq: e.seq, source: d.source, at: iso(d.at ?? e.at), target: d.target, text: d.text, from: d.who, who: d.who, where: d.where, link: d.link, routedTo: [...new Set([...d.routedTo, ...on])], objective, route: hops, thread: fed?.id, taskId: task && taskRef(task.id), context: contextOf(d), ...(d.own && { own: true }), delivery: delivery(d, [...new Set([...d.routedTo, ...on])]) };
    }
    const thread = d.source === "isaac" ? threads.find((t) => t.messages.some((m) => m.from === "isaac" && m.text === d.text))?.id : undefined;
    return { id: `s${e.seq}`, seq: e.seq, source: d.source, at: iso(e.at), target: d.target, text: d.text, from: d.from, routedTo: r ? [...d.routedTo, ...r.routedTo] : d.routedTo, objective: r?.objective ?? d.objective, route, thread, delivery: delivery(d, [...d.routedTo, ...(r?.routedTo ?? [])]) } as { id: string; seq: number; source: Source; at: string; target: string; text: string; from?: string; routedTo: string[]; objective?: string; route: unknown[]; thread?: string; delivery: Record<string, string>; who?: string; where?: string; link?: string; taskId?: string; context?: unknown[]; own?: boolean };
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const mergedInto = (id?: string): string | undefined => { const o = objectives.find((x) => x.id === id); return o?.mergedInto ? mergedInto(o.mergedInto) : id; };
  const objectiveOf = (sig: (typeof signals)[number]) => mergedInto(sig.objective ?? sig.routedTo.map((id) => sessions.get(id)?.role?.objective).find(Boolean));
  const fromKind = (sig: (typeof signals)[number]) => (sig.source === "isaac" ? "isaac" : sig.from && sessions.get(sig.from)?.role?.role === "router" ? "router" : sig.source === "agent" ? "agent" : "sentry");
  const os = objectives.filter((o) => !o.closed).map((o) => ({
    id: o.id,
    title: o.title,
    cwd: o.cwd,
    taskIds: shown.filter((t) => t.objective === o.id).map((t) => taskRef(t.id)),
    events: signals.filter((sig) => objectiveOf(sig) === o.id).slice(0, 50).reverse().map((sig) => ({ from: fromKind(sig), at: sig.at, text: sig.text })),
    page: o.page,
  }));
  if (unrouted.length) os.push({ id: UNROUTED, title: "Unrouted", cwd: DIR, taskIds: [], events: [], page: [] });
  return {
    objectives: os,
    agents: out,
    tasks: shown.map((t) => ({
      id: taskRef(t.id),
      title: t.title,
      status: v2Status(t),
      board: t.status,
      agent: t.sessions.at(-1),
      pr: Number(t.links.map((u) => u.match(/\/pull\/(\d+)/)?.[1]).find(Boolean)) || undefined,
      links: t.links,
      dependsOn: [],
      start: iso(t.at),
      ...(t.status === "done" && { end: iso(t.updated) }),
      events: t.timeline.map((e) => ({ from: e.session && sessions.get(e.session)?.role?.role === "router" ? "router" : e.session ? "agent" : "sentry", at: iso(e.at), text: e.text })),
      page: t.page ?? [],
    })),
    threads: [
      ...threads.filter((t) => !t.mergedInto).map((t) => ({ id: t.id, title: t.title, objectiveId: t.objective, ...(t.parent && { parentId: t.parent.thread, parentMessageId: t.parent.message }), routerIds: t.routers, pending: pendingOf(t.pending), ...(t.asks && !t.paused && !t.resolved && { asks: { sessionId: t.asks.session, since: iso(t.asks.since), shown: !!t.asks.shown } }), taskId: t.task && taskRef(t.task), ...(t.resolved && { resolved: { at: iso(t.resolved.at) } }), ...(t.paused && { paused: { until: iso(t.paused.until), at: iso(t.paused.at), said: t.paused.said, posts: t.paused.posts ?? 0, ...(t.paused.wake && { wake: t.paused.wake }) } }), ...(t.resurfaced && { resurfaced: { at: iso(t.resurfaced.at), from: t.resurfaced.from } }), ...(t.pinned && { pinned: { at: iso(t.pinned.at), order: t.pinned.order } }), ...(t.feed && { feed: { source: t.feed.source, who: t.feed.who, link: t.feed.link } }), messages: t.messages.map((m) => ({ id: m.id, from: m.from, at: iso(m.at), text: m.text, ...(m.nudge && { nudge: m.nudge }), ...(m.wake && { wake: true }), ...(m.ext && { ext: m.ext }) })) })),
      ...movedStubs(),
    ],
    signals,
    sentries: [...sessions.values()].filter(isSentry).map((s) => ({
      id: s.id,
      name: s.name.replace(/^sentry:/, ""),
      running: live(s),
      agent: isAgent(s),
      status: status(s),
      // To 10s: it moves with every line a sentry prints, and every move re-sent every sentry to every tab.
      lastOutputAt: Math.floor(s.lastOutputAt / 10_000) * 10_000,
      createdAt: s.createdAt,
      ties: sentryTies[s.name]?.() ?? [],
      use: SENTRY_USES[s.name] ?? "",
    })),
    // The shells agents wait on: what each waits for, its command or process, and how it ended.
    shells: shells.map(({ file: _, ...x }) => x),
    // Every PR the gh sentry polls, so a PR named in a message shows its title and state.
    // Sessions that have ended, by the name they last went by.
    names: (rememberNames(), Object.fromEntries(Object.entries(names).filter(([id]) => !live(sessions.get(id))))),
    prs: Object.fromEntries(Object.entries(ghStatus()).map(([key, { pr }]) => [key.toLowerCase(), { title: pr.title, state: pr.state.toLowerCase() }])),
  };
}
