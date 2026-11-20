import { mkdirSync } from "node:fs";
import { inboxesTable, watchedStateFile, writeStateText } from "./state";
import { publish } from "./bus";
import { BASE, CLI, DIR, ARE_AGENTS_INERT, INERT_CWD, INSTANCE, MAX_SESSIONS } from "./instance";
import { TMUX, launchable, named, paneEnv, didRespawn, scoped, setOption, termEnv, tmux, tmuxAsync, tmuxName } from "./tmux";
import { type ClaudeState, type Role, type Session, type Wait, chatOf, isAgent, isSentry, sessions } from "./sessions";
import { type Signal, type Source, TASK_STATUSES, type Task, type TaskEdit, type Thread } from "./model";
import { isLive, saveTasks, tasks, threads } from "./stores";
import { patch } from "./patch";
import { isFilled } from "./shared/guards";
import { postAsYarn, threadsItIsOn, workLeftOpenAtSleep, workStillRunningInside } from "./sleep";

const SCROLLBACK_BYTES = 2 * 1024 * 1024;
const ESC = "\u{1B}";
const BEL = "\u{7}";
const SGR = new RegExp(String.raw`${ESC}\[[\d;]*m`, "g");
const CURSOR_MOVE = new RegExp(String.raw`${ESC}\[[\d;]*[HfABCDG]`, "g");
const OTHER_ESCAPE = new RegExp(String.raw`${ESC}(\][^${BEL}]*${BEL}|\[[\d;?<>=]*[ -/]*[@-~]|[()][\w]|.)`, "g");

function trimScrollback(session: Session) {
  let { bytes } = session;
  while (bytes > SCROLLBACK_BYTES && session.chunks.length > 1) bytes -= session.chunks.shift()?.length ?? 0;
  patch(session, { bytes });
}
export function push(session: Session, chunk: Uint8Array) {
  session.chunks.push(chunk);
  patch(session, { bytes: session.bytes + chunk.length, lastOutputAt: Date.now() });
  trimScrollback(session);
  for (const ws of session.clients) if (!ws.data.pty) ws.sendBinary(chunk);
}

async function reattachOrEndWhenViewerExits(session: Session, exited: Promise<number>, cols: number, rows: number) {
  await exited;
  if (sessions.get(session.id) !== session) return;
  if (tmux("has-session", "-t", tmuxName(session.id)).ok) {
    setTimeout(() => attachViewer(session, cols, rows), 500);
    return;
  }
  patch(session, { exitCode: 0 });
  tellWaiters(session, "exited");
  push(session, new TextEncoder().encode(`\r\n${ESC}[2m[session ended]${ESC}[0m\r\n`));
}
export function attachViewer(session: Session, cols = 120, rows = 34) {
  const proc = Bun.spawn([...TMUX, "attach-session", "-t", tmuxName(session.id)], {
    env: termEnv,
    terminal: { cols, rows, data: (_term, data) => push(session, new Uint8Array(data)) },
  });
  patch(session, { proc });
  void reattachOrEndWhenViewerExits(session, proc.exited, cols, rows);
}

export class SessionCap extends Error {}
const isNewInertClaude = (cmd: string[]) => ARE_AGENTS_INERT && cmd[0] === "claude" && !cmd.includes("--resume");
type PaneOptions = { chatId?: string | undefined; role?: Role | undefined; cols?: number; rows?: number };
export function createSession(name: string, cmd: string[], cwd: string, { chatId, role, cols = 120, rows = 34 }: PaneOptions = {}): Session {
  const running = sessions.values().filter((s) => s.exitCode === null && s.sentry !== true).toArray().length;
  if (running >= MAX_SESSIONS && !name.startsWith("sentry:"))
    throw new SessionCap(`dev instance "${INSTANCE}" already runs ${running} sessions, its cap; end some, or raise YARN_MAX_SESSIONS`);
  // constraint: claude finds a resumed chat's transcript by its cwd, so only a new inert claude moves to INERT_CWD
  const paneCwd = isNewInertClaude(cmd) ? INERT_CWD : cwd;
  if (isNewInertClaude(cmd)) mkdirSync(paneCwd, { recursive: true });
  const id = crypto.randomUUID().slice(0, 8);
  const session = { id, name, cmd, cwd: paneCwd, chatId, createdAt: Date.now(), lastOutputAt: Date.now(), chunks: [], bytes: 0, clients: new Set(), exitCode: null, inbox: [] } as unknown as Session;
  const t = tmuxName(id);
  const meta = { name, cmd: cmd.map((a) => (a.length > 2000 ? `${a.slice(0, 2000)}…` : a)), cwd: paneCwd, chatId, createdAt: session.createdAt };
  const created = scoped("new-session", "-d", "-s", t, "-x", String(cols), "-y", String(rows), "-c", paneCwd, ...paneEnv(id), "--", ...launchable(id, cmd),
    ";", "set-option", "-t", t, "@mf", JSON.stringify(meta), ...(role ? [";", "set-option", "-t", t, "@mf-role", JSON.stringify(role)] : []));
  if (!created.ok) throw new Error(`tmux new-session failed for ${cmd.join(" ").slice(0, 200)}`);
  if (role) session.role = role;
  sessions.set(id, session);
  attachViewer(session, cols, rows);
  return session;
}

export function saveInbox(s: Session) {
  if (s.inbox.length === 0 && s.sending === undefined) inboxesTable.delete(s.id);
  else inboxesTable.put(s.id, { inbox: s.inbox, ...(s.sending && { sending: { count: s.sending.count, at: s.sending.at } }) });
}
const stopping = new Set<string>();

export function setClaudeState(s: Session, state: ClaudeState | "gone") {
  patch(s, { claude: state === "gone" ? undefined : { state, at: Date.now() } });
  setOption(s.id, "@mf-claude", s.claude ? JSON.stringify(s.claude) : "");
}

export function enqueue(s: Session, text: string) {
  s.inbox.push(text);
  saveInbox(s);
  wake(s);
}
function sourceOf(from?: Session): Source {
  if (!from) return "yarn";
  if (!isSentry(from)) return "agent";
  if (from.name === "sentry:gh") return "gh";
  return from.name === "sentry:slack" ? "slack" : "sentry";
}
function targetOf(source: Source, text: string, from?: Session) {
  const pr = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/.exec(text) ?? /\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(text);
  if (pr) return `${(pr[1] ?? "").split("/", 2)[1] ?? ""}#${pr[2] ?? ""}`;
  if (source === "slack") return /#[\w-]+/.exec(text)?.[0] ?? "slack";
  if (from) return from.name.replace(/^sentry:/, "");
  return source === "isaac" ? "chat" : "yarn";
}
export const isReachable = (s?: Session): s is Session => isLive(s) && isAgent(s);
export const funnel = () => sessions.values().find((s) => s.name === "sentry:funnel" && isSentry(s) && isLive(s));
export function routersOf(objective: string): Session[] {
  const all = sessions.values().filter((s) => isReachable(s) && s.role?.role === "router" && s.role.objective === objective).toArray();
  const own = all.filter((s) => s.role?.merged !== true);
  const pool = own.length > 0 ? own : all;
  return pool.filter((s) => newerRouterOnScope(s, pool) === undefined);
}
export const newerRouterOnScope = (s: Session, pool: Session[] = routersOf(s.role?.objective ?? "")): Session | undefined =>
  pool.find((x) => x !== s && x.role?.scope === s.role?.scope && x.createdAt > s.createdAt);

type Dispatch = { text: string; source?: Source; from?: Session; to?: Session[]; objective?: string; target?: string; deliver?: string | ((seq: number) => string); typed?: boolean };
const recipientsOf = (objective: string | undefined) => (isFilled(objective) ? routersOf(objective) : [funnel()].filter(isLive));
function deliveredText(m: Dispatch, source: Source, seq: number) {
  const text = typeof m.deliver === "function" ? m.deliver(seq) : (m.deliver ?? m.text);
  const isHisOwnTypedWords = source === "isaac" && (m.deliver === undefined || m.deliver === "");
  // constraint: Claude Code reads a prompt starting with ! as a shell command, / as a slash command and # as a memory
  return !isHisOwnTypedWords && /^[!/#]/.test(text) ? ` ${text}` : text;
}
export function dispatch(m: Dispatch) {
  const source = m.source ?? sourceOf(m.from);
  const to = m.to ?? recipientsOf(m.objective);
  const signal: Signal = { source, ...(m.from && { from: m.from.id }), target: m.target ?? targetOf(source, m.text, m.from), text: m.text, routedTo: to.map((s) => s.id), ...(isFilled(m.objective) && { objective: m.objective }) };
  const ev = publish(`signal/${source}`, signal);
  const delivered = deliveredText(m, source, ev.seq);
  if (m.typed !== true) for (const s of to) enqueue(s, delivered);
  return ev;
}
export const live_thread = (t?: Thread): Thread | undefined => {
  const into = t?.mergedInto;
  return isFilled(into) ? live_thread(threads.find((x) => x.id === into)) : t;
};

export function setArchived(s: Session, isArchived: boolean) {
  patch(s, { archived: isArchived });
  setOption(s.id, "@mf-archived", isArchived ? "1" : "0");
  if (isArchived) void stopAgent(s);
  else {
    patch(s, { sleepHeld: undefined });
    resumeAgent(s);
  }
}
const isStoppable = (s: Session, chat: string | undefined) =>
  s.archived === true && !isFilled(s.asleep) && isFilled(chat) && !isSentry(s) && isAgent(s) && s.exitCode === null && s.claude?.state !== "working" && s.claude?.state !== "waiting";
export async function stopAgent(s: Session) {
  const chat = chatOf(s);
  if (!isStoppable(s, chat) || stopping.has(s.id)) return;
  stopping.add(s.id);
  try {
    const box = await inputBox(s);
    if (box?.empty !== true || !isStoppable(s, chat) || !isFilled(chat)) return;
    const running = await workStillRunningInside(s, box.screen);
    if (running.length > 0) holdAwake(s, running);
    else if (isStoppable(s, chat)) putToSleep(s, chat);
  } finally {
    stopping.delete(s.id);
  }
}
function holdAwake(s: Session, running: string[]) {
  if (s.sleepHeld?.what.join(",") === running.join(",")) return;
  patch(s, { sleepHeld: { what: running, at: Date.now() } });
  publish(`sleep-held/${s.id}`, { session: s.id, what: running });
}
function putToSleep(s: Session, chat: string) {
  const lastReplyScreen = tmux("capture-pane", "-p", "-e", "-J", "-t", tmuxName(s.id)).out.trimEnd();
  const lastReplyScreenFile = writeStateText(`asleep-${s.id}.ans`, `${lastReplyScreen}${ESC}[0m\n`);
  if (!didRespawn(s.id, "--", process.execPath, `${DIR}/sleeper.ts`, lastReplyScreenFile, BASE, s.id)) return;
  const at = Date.now();
  patch(s, { asleep: chat, sleptAt: at, sleepHeld: undefined });
  setOption(s.id, "@mf-asleep", chat);
  setClaudeState(s, "gone");
  publish(`asleep/${s.id}`, { session: s.id, wait: s.wait ?? null });
  raiseIfWorkLeftOpen(s);
}
function raiseIfWorkLeftOpen(s: Session) {
  const open = workLeftOpenAtSleep(s);
  if (open.length === 0) return;
  const text = `⚠ ${s.name} (${s.id}) was put to sleep with work still open: ${open.join("; ")}. Nothing will pick this up on its own: wake it from its agent page or answer it.`;
  for (const t of threadsItIsOn(s)) postAsYarn(t, text);
  const owner = [sessions.get(s.role?.parent ?? ""), ...routersOf(s.role?.objective ?? ""), funnel()].find((x): x is Session => isReachable(x) && x !== s);
  if (owner) dispatch({ to: [owner], target: s.name, text: `[yarn] ${text} Wake it (\`${CLI} send ${s.id} '<what to do>'\`) or take its work over.` });
  publish(`health/agent/${s.id}`, { session: s.id, name: s.name, open });
}
export function resumeAgent(s: Session) {
  const chat = s.asleep;
  if (!isFilled(chat) || s.exitCode !== null) return;
  const bypass = s.cmd.some((a) => a.includes("bypassPermissions")) ? ["--permission-mode", "bypassPermissions"] : [];
  if (!didRespawn(s.id, "-c", s.cwd, ...paneEnv(s.id), "--", ...named(s.id, ["claude", "--resume", chat, ...bypass]))) return;
  patch(s, { asleep: undefined, sleptAt: undefined });
  setOption(s.id, "@mf-asleep", "");
}
export function setWait(s: Session, wait?: Wait) {
  patch(s, { wait });
  setOption(s.id, "@mf-wait", wait ? JSON.stringify(wait) : "");
  publish(`wait/${s.id}`, { session: s.id, wait: wait ?? null });
  settleTasks();
}

export function wake(s: Session) {
  if (s.archived === true) setArchived(s, false);
  else if (isFilled(s.asleep)) resumeAgent(s);
  if (s.wait && s.wait.awake !== true) setWait(s, { ...s.wait, awake: true });
}
export function endWait(s: Session, why?: string) {
  const was = s.wait;
  if (!was) return;
  setWait(s);
  if (s.archived === true) setArchived(s, false);
  if (isFilled(why)) dispatch({ to: [s], target: waitLabel(was), text: `[yarn] Your wait on ${waitLabel(was)} is over: ${why}${why.endsWith("```") ? "" : "."}` });
}

export function tellWaiters(on: Session, what: string, isTold: (waiter: Session) => boolean = () => true) {
  for (const w of sessions.values())
    if (w !== on && isWaitingOn(w, on.id) && w.exitCode === null && isTold(w)) endWait(w, `"${on.name}" (session ${on.id}) ${what}`);
}
export const isWaitingOn = (w: Session, id?: string | null) => w.wait?.kind === "agent" && typeof id === "string" && id !== "" && w.wait.ref.split(",").includes(id);
export function waitLabel(w: Wait) {
  if (w.kind === "done") return "done";
  return w.kind === "until" ? `until "${w.desc}"` : `${w.kind}:${w.ref}`;
}
export const taskPrs = watchedStateFile<Record<string, string>>("task-prs.json", {});
export function threadOf(ref: string) {
  const question = /^q?\d+$/.test(ref) ? Number(ref.replace(/^q/, "")) : undefined;
  return live_thread(threads.find((t) => (question === undefined ? t.id === ref : t.q === question)));
}

function createTask(title: string, at: number): Task {
  const t: Task = { id: (tasks.at(-1)?.id ?? 0) + 1, title, kind: "task", status: "todo", sessions: [], links: [], at, updated: at, timeline: [] };
  tasks.push(t);
  return t;
}
function addOwnersObjective(t: Task, session: string | undefined) {
  if (t.objective !== undefined) return;
  const objective = isFilled(session) ? sessions.get(session)?.role?.objective : undefined;
  if (objective !== undefined) patch(t, { objective });
}
function recordOnTimeline(t: Task, edit: TaskEdit, at: number, isMoved: boolean) {
  if (!isMoved && !isFilled(edit.event)) return;
  t.timeline.push({ at, text: edit.event ?? `moved to ${t.status}`, ...(isFilled(edit.session) && { session: edit.session }) });
  t.timeline.sort((a, b) => a.at - b.at);
}
function editRefusal(task: Task | undefined, edit: TaskEdit) {
  if (edit.status && !TASK_STATUSES.includes(edit.status)) return `status is one of ${TASK_STATUSES.join(", ")}`;
  if (!task && !isFilled(edit.title)) return "a new task needs a title";
  return null;
}
export function editTask(task: Task | undefined, edit: TaskEdit) {
  const refusal = editRefusal(task, edit);
  if (refusal !== null) return refusal;
  const at = edit.at ?? Date.now();
  const t = task ?? createTask(edit.title ?? "", at);
  const isMoved = edit.status !== undefined && edit.status !== t.status;
  Object.assign(t, Object.fromEntries(Object.entries({ title: edit.title, kind: edit.kind, status: edit.status, answer: edit.answer, objective: edit.objective }).filter(([, v]) => v !== undefined)));
  addOwnersObjective(t, edit.session);
  if (isFilled(edit.session) && !t.sessions.includes(edit.session)) t.sessions.push(edit.session);
  if (isFilled(edit.link) && !t.links.includes(edit.link)) t.links.push(edit.link);
  recordOnTimeline(t, edit, at, isMoved);
  patch(t, { updated: Math.max(t.updated, at) });
  saveTasks();
  return t;
}

const DONE_ARCHIVE_MS = 3_600_000;
export const newestTaskOf = (id: string) => tasks.findLast((t) => t.sessions.includes(id) && t.status !== "dropped");
type Derived = { to: Task["status"]; why: string };
function deriveFromAgents(onIt: Session[]): Derived | undefined {
  const asking = onIt.find((s) => s.wait?.kind === "thread" && threadOf(s.wait.ref)?.asks !== undefined);
  if (asking) return { to: "you", why: `${asking.name} is asleep until you answer in thread ${asking.wait?.ref ?? ""}` };
  const working = onIt.find((s) => s.wait === undefined || s.wait.awake === true || s.inbox.length > 0);
  if (working) return { to: "doing", why: `${working.name} is working` };
  const asleep = onIt.map((s) => ({ s, wait: s.wait })).find((x): x is { s: Session; wait: Wait } => x.wait !== undefined && x.wait.kind !== "done");
  if (asleep) return { to: "waiting", why: `${asleep.s.name} waits on ${waitLabel(asleep.wait)}` };
  return undefined;
}
export function derive(t: Task): Derived | null {
  const onIt = t.sessions.flatMap((id) => sessions.get(id) ?? []).filter((s) => s.exitCode === null && isAgent(s) && newestTaskOf(s.id) === t);
  if (onIt.length === 0) return null;
  const fromAgents = deriveFromAgents(onIt);
  if (fromAgents) return fromAgents;
  const open = t.links.filter((u) => taskPrs()[u] === "OPEN").length;
  if (open > 0) return { to: "waiting", why: `its agents are done and ${open === 1 ? "1 PR is" : `${open} PRs are`} still open` };
  if (t.kind === "question" && !isFilled(t.answer)) return null;
  return { to: "done", why: "every agent on it is done" };
}
function settleTask(t: Task) {
  if (t.status === "blocked" || t.status === "dropped" || t.status === "done") return;
  const d = derive(t);
  if (!d || d.to === t.derived) return;
  patch(t, { derived: d.to });
  if (d.to === t.status) saveTasks();
  else editTask(t, { status: d.to, event: `${d.to === "done" ? "done" : `moved to ${d.to}`}: ${d.why}` });
  publish(`task/${t.id}`, { id: t.id, status: t.status, why: d.why });
}
function archiveAgentsOfTaskDoneAnHourAgo(t: Task) {
  if (t.status !== "done" || Date.now() - t.updated < DONE_ARCHIVE_MS) return;
  for (const id of t.sessions) {
    const s = sessions.get(id);
    if (s && s.archived !== true && s.exitCode === null && s.wait?.kind === "done" && newestTaskOf(id) === t) setArchived(s, true);
  }
}
export function settleTasks() {
  for (const t of tasks) settleTask(t);
  for (const t of tasks) archiveAgentsOfTaskDoneAnHourAgo(t);
}

const roughStripOfRawStream = (s: Session) =>
  new TextDecoder().decode(Buffer.concat(s.chunks)).replaceAll(CURSOR_MOVE, "\n").replaceAll(OTHER_ESCAPE, "").replaceAll(/\n\s*\n+/g, "\n").trimEnd();
export function screen(s: Session, history: number) {
  const capture = s.exitCode === null ? tmux("capture-pane", "-p", "-J", "-t", tmuxName(s.id), ...(history > 0 ? ["-S", String(-history)] : [])) : undefined;
  if (capture?.ok === true) {
    const visible = capture.out.trimEnd();
    patch(s, { lastScreen: visible });
    return visible;
  }
  return s.lastScreen ?? roughStripOfRawStream(s);
}

const plain = (l: string) => l.replaceAll(SGR, "");
const isBoxBorder = (l: string) => /^─{10,}/.test(plain(l).trim());
export async function inputBox(s: Session) {
  const lines = (await tmuxAsync("capture-pane", "-p", "-e", "-t", tmuxName(s.id))).out.split("\n");
  const i = lines.findLastIndex((l, j) => j > 0 && plain(l).startsWith("❯") && isBoxBorder(lines[j - 1] ?? ""));
  if (i === -1) return null;
  const end = lines.findIndex((l, j) => j > i && isBoxBorder(l));
  const promptLine = lines[i] ?? "";
  const first = promptLine.slice(promptLine.indexOf("❯") + 1).trimStart();
  const text = lines.slice(i, end === -1 ? undefined : end).map(plain).join("\n").replace(/^❯/, "").trim();
  return { text, empty: first.startsWith(`${ESC}[2m`) || text === "", screen: lines.slice(end === -1 ? i : end).map(plain).join("\n") };
}
