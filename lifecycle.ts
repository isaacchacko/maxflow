import { mkdirSync } from "node:fs";
import { agents } from "./stats";
import { inboxesTable, watchedStateFile, writeStateText } from "./state";
import { publish } from "./bus";
import { BASE, DIR, INERT_AGENTS, INERT_CWD, INSTANCE, MAX_SESSIONS } from "./instance";
import { TMUX, launchable, named, paneEnv, respawn, scoped, setOption, termEnv, tmux, tmuxAsync, tmuxName } from "./tmux";
import { type ClaudeState, type Role, type Session, type Wait, chatOf, isAgent, isSentry, sessions } from "./sessions";
import { type Signal, type Source, TASK_STATUSES, type Task, type TaskEdit, type Thread } from "./model";
import { live, saveTasks, tasks, threads } from "./stores";

const SCROLLBACK_BYTES = 2 * 1024 * 1024;

export function push(session: Session, chunk: Uint8Array) {
  session.chunks.push(chunk);
  session.bytes += chunk.length;
  session.lastOutputAt = Date.now();
  while (session.bytes > SCROLLBACK_BYTES && session.chunks.length > 1) session.bytes -= session.chunks.shift()!.length;
  for (const ws of session.clients) if (!ws.data.pty) ws.sendBinary(chunk);
}

export function attachViewer(session: Session, cols = 120, rows = 34) {
  session.proc = Bun.spawn([...TMUX, "attach-session", "-t", tmuxName(session.id)], {
    env: termEnv,
    terminal: { cols, rows, data: (_term, data) => push(session, new Uint8Array(data)) },
  });
  session.proc.exited.then(() => {
    if (sessions.get(session.id) !== session) return;
    if (tmux("has-session", "-t", tmuxName(session.id)).ok) return void setTimeout(() => attachViewer(session, cols, rows), 500);
    session.exitCode = 0;
    tellWaiters(session, "exited");
    push(session, new TextEncoder().encode(`\r\n\x1b[2m[session ended]\x1b[0m\r\n`));
  });
}

// Answered as a plain 429 rather than Bun's error page, so an agent's cli call reads why.
export class SessionCap extends Error {}
export function createSession(name: string, cmd: string[], cwd: string, chatId?: string, role?: Role, cols = 120, rows = 34): Session {
  const running = [...sessions.values()].filter((s) => s.exitCode === null && !s.sentry).length;
  if (running >= MAX_SESSIONS && !name.startsWith("sentry:"))
    throw new SessionCap(`dev instance "${INSTANCE}" already runs ${running} sessions, its cap; end some, or raise MAXFLOW_MAX_SESSIONS`);
  // A resumed chat keeps its own folder, since claude finds its transcript by cwd.
  if (INERT_AGENTS && cmd[0] === "claude" && !cmd.includes("--resume")) mkdirSync((cwd = INERT_CWD), { recursive: true });
  const id = crypto.randomUUID().slice(0, 8);
  const session = { id, name, cmd, cwd, chatId, createdAt: Date.now(), lastOutputAt: Date.now(), chunks: [], bytes: 0, clients: new Set(), exitCode: null, inbox: [] } as unknown as Session;
  const t = tmuxName(id);
  const meta = { name, cmd: cmd.map((a) => (a.length > 2000 ? `${a.slice(0, 2000)}…` : a)), cwd, chatId, createdAt: session.createdAt };
  const created = scoped("new-session", "-d", "-s", t, "-x", String(cols), "-y", String(rows), "-c", cwd, ...paneEnv(id), "--", ...launchable(id, cmd),
    ";", "set-option", "-t", t, "@mf", JSON.stringify(meta), ...(role ? [";", "set-option", "-t", t, "@mf-role", JSON.stringify(role)] : []));
  if (!created.ok) throw new Error(`tmux new-session failed for ${cmd.join(" ").slice(0, 200)}`);
  if (role) session.role = role;
  sessions.set(id, session);
  attachViewer(session, cols, rows);
  return session;
}

// A session's inbox and the paste in flight, kept in state.ts before anything is typed, so a restart delivers each message once.
// They were the tmux option @mf-inbox, which tmux refuses past ~16KB ("command too long"), so a long inbox kept an old value holding
// messages already delivered, and each restart in a run of deploys delivered them again (258121 four times on 2026-11-19).
export function saveInbox(s: Session) {
  if (s.inbox.length === 0 && s.sending === undefined) inboxesTable.delete(s.id);
  else inboxesTable.put(s.id, { inbox: s.inbox, ...(s.sending && { sending: { count: s.sending.count, at: s.sending.at } }) });
}
// Agents stopAgent is reading the box of, so two callers don't stop one twice.
const stopping = new Set<string>();

export function setClaudeState(s: Session, state: ClaudeState | "gone") {
  s.claude = state === "gone" ? undefined : { state, at: Date.now() };
  setOption(s.id, "@mf-claude", s.claude ? JSON.stringify(s.claude) : "");
}

// The inbox lives in a file too (saveInbox), so a server restart doesn't drop a message the agent hasn't been given yet.
// Only dispatch() calls it: every message reaches an agent through the event log.
export function enqueue(s: Session, text: string) {
  s.inbox.push(text);
  saveInbox(s);
  wake(s);
}
const sourceOf = (from?: Session): Source =>
  !from ? "maxflow" : isSentry(from) ? (from.name === "sentry:gh" ? "gh" : from.name === "sentry:slack" ? "slack" : "sentry") : "agent";
// What a signal is about, for the event log: a PR, a Slack channel, or who sent it.
function targetOf(source: Source, text: string, from?: Session) {
  const pr = text.match(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/) ?? text.match(/\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (pr) return `${pr[1].split("/")[1]}#${pr[2]}`;
  if (source === "slack") return text.match(/#[\w-]+/)?.[0] ?? "slack";
  return from ? from.name.replace(/^sentry:/, "") : source === "isaac" ? "chat" : "maxflow";
}
// A session that can take a message: up, and an agent. A routed session that is a plain shell (claude never ran in it, as in
// 662ba653) would queue his messages where nothing reads them, so it doesn't count as a thread's owner and his reply goes on.
export const reachable = (s?: Session): s is Session => live(s) && isAgent(s);
export const funnel = () => [...sessions.values()].find((s) => s.name === "sentry:funnel" && isSentry(s) && live(s));
export function routersOf(objective: string): Session[] {
  const all = [...sessions.values()].filter((s) => reachable(s) && s.role?.role === "router" && s.role.objective === objective);
  const own = all.filter((s) => !s.role!.merged);
  const pool = own.length ? own : all;
  return pool.filter((s) => newerRouterOnScope(s, pool) === undefined);
}
export const newerRouterOnScope = (s: Session, pool: Session[] = routersOf(s.role?.objective ?? "")): Session | undefined =>
  pool.find((x) => x !== s && x.role?.scope === s.role?.scope && x.createdAt > s.createdAt);

// typed: the text already reached the session (typed by `maxflow send`, or as a new router's first prompt), so it is only logged.
// deliver: what the agents get instead of the logged text, given the signal's number.
export function dispatch(m: { text: string; source?: Source; from?: Session; to?: Session[]; objective?: string; target?: string; deliver?: string | ((seq: number) => string); typed?: boolean }) {
  const source = m.source ?? sourceOf(m.from);
  const to = m.to ?? (m.objective ? routersOf(m.objective) : [funnel()].filter(live));
  const signal: Signal = { source, ...(m.from && { from: m.from.id }), target: m.target ?? targetOf(source, m.text, m.from), text: m.text, routedTo: to.map((s) => s.id), ...(m.objective && { objective: m.objective }) };
  const ev = publish(`signal/${source}`, signal);
  const text = typeof m.deliver === "function" ? m.deliver(ev.seq) : (m.deliver ?? m.text);
  // Claude Code takes a prompt starting with ! as a shell command, / as a slash command and # as a memory, so a delivery that
  // starts with one (an image-only inbox message is "![image](…)") gets a space ahead. Only his own words typed into a pane keep theirs.
  const delivered = /^[!/#]/.test(text) && !(source === "isaac" && !m.deliver) ? ` ${text}` : text;
  if (!m.typed) for (const s of to) enqueue(s, delivered);
  return ev;
}
// A thread folded into another as a duplicate answers for that one.
export const live_thread = (t?: Thread): Thread | undefined => (t?.mergedInto ? live_thread(threads.find((x) => x.id === t.mergedInto)) : t);

export function setArchived(s: Session, archived: boolean) {
  s.archived = archived;
  setOption(s.id, "@mf-archived", archived ? "1" : "0");
  if (archived) stopAgent(s);
  else resumeAgent(s);
}
// An archived agent between turns has its claude stopped, keeping the tmux session, so it holds no memory until it is unarchived.
// Not while its box holds text: what he typed and hasn't sent (or a paste whose Enter didn't take) would die with the claude, as his
// "run a test draft on 7d6e474d" did in bedd13e5. It stays up, and checkClaude stops it once the box is empty.
export async function stopAgent(s: Session) {
  const chat = chatOf(s);
  const stoppable = () => s.archived && !s.asleep && !!chat && !isSentry(s) && isAgent(s) && s.exitCode === null && s.claude?.state !== "working" && s.claude?.state !== "waiting";
  if (!stoppable() || stopping.has(s.id)) return;
  stopping.add(s.id);
  try {
    const box = await inputBox(s);
    if (!box?.empty || !stoppable()) return;
    putToSleep(s, chat!);
  } finally {
    stopping.delete(s.id);
  }
}
function putToSleep(s: Session, chat: string) {
  // The respawn keeps the pane's history but wipes its screen, which holds the chat's last reply, so the placeholder prints that screen back first.
  const screenFile = writeStateText(`asleep-${s.id}.ans`, tmux("capture-pane", "-p", "-e", "-J", "-t", tmuxName(s.id)).out.trimEnd() + "\x1b[0m\n");
  if (!respawn(s.id, "--", process.execPath, `${DIR}/sleeper.ts`, screenFile, BASE, s.id)) return;
  s.asleep = chat;
  setOption(s.id, "@mf-asleep", chat);
  setClaudeState(s, "gone");
}
export function resumeAgent(s: Session) {
  if (!s.asleep || s.exitCode !== null) return;
  const bypass = s.cmd.some((a) => a.includes("bypassPermissions")) ? ["--permission-mode", "bypassPermissions"] : [];
  if (!respawn(s.id, "-c", s.cwd, ...paneEnv(s.id), "--", ...named(s.id, ["claude", "--resume", s.asleep, ...bypass]))) return;
  s.asleep = undefined;
  setOption(s.id, "@mf-asleep", "");
}
export function setWait(s: Session, wait?: Wait) {
  s.wait = wait;
  setOption(s.id, "@mf-wait", wait ? JSON.stringify(wait) : "");
  publish(`wait/${s.id}`, { session: s.id, wait: wait ?? null });
  settleTasks();
}

// Waiting is sleeping: a waiting agent is archived once its turn ends, and the first message queued to it wakes it for a turn.
// Only the awaited event ends the wait: a question settled, an approval, CI finishing, the PR merged or closed, the agent's reply, a new Slack message.
// Any message wakes it, whatever put it to sleep (a wait, done, archived by hand): it needs a live claude to land in.
export function wake(s: Session) {
  if (s.archived) setArchived(s, false);
  else if (s.asleep) resumeAgent(s);
  if (s.wait && !s.wait.awake) setWait(s, { ...s.wait, awake: true });
}
export function endWait(s: Session, why?: string) {
  const was = s.wait;
  if (!was) return;
  setWait(s);
  if (s.archived) setArchived(s, false);
  if (why) dispatch({ to: [s], target: waitLabel(was), text: `[maxflow] Your wait on ${waitLabel(was)} is over: ${why}${why.endsWith("```") ? "" : "."}` });
}

// An agent waiting on another hears when that one exits or goes to sleep itself.
export function tellWaiters(on: Session, what: string) {
  for (const w of sessions.values())
    if (w !== on && waitsOn(w, on.id) && w.exitCode === null) endWait(w, `"${on.name}" (session ${on.id}) ${what}`);
}
export const waitsOn = (w: Session, id?: string | null) => w.wait?.kind === "agent" && !!id && w.wait.ref.split(",").includes(id);
export const waitLabel = (w: Wait) => (w.kind === "done" ? "done" : w.kind === "until" ? `until "${w.desc}"` : `${w.kind}:${w.ref}`);
// The state of each PR a task links, { url: OPEN | MERGED | CLOSED }, which the assistant sentry's feed looks up on GitHub.
export const taskPrs = watchedStateFile<Record<string, string>>("task-prs.json", {});
export const threadOf = (ref: string) => live_thread(/^q?\d+$/.test(ref) ? threads.find((t) => t.q === Number(ref.replace(/^q/, ""))) : threads.find((t) => t.id === ref));

// at: when the event happened, which the assistant reads from the transcript it took it from; it defaults to now.
export function editTask(t: Task | undefined, edit: TaskEdit) {
  if (edit.status && !TASK_STATUSES.includes(edit.status)) return `status is one of ${TASK_STATUSES.join(", ")}`;
  const at = edit.at ?? Date.now();
  if (!t) {
    if (!edit.title) return "a new task needs a title";
    t = { id: (tasks.at(-1)?.id ?? 0) + 1, title: edit.title, kind: "task", status: "todo", sessions: [], links: [], at, updated: at, timeline: [] };
    tasks.push(t);
  }
  const moved = edit.status && edit.status !== t.status;
  Object.assign(t, Object.fromEntries(Object.entries({ title: edit.title, kind: edit.kind, status: edit.status, answer: edit.answer, objective: edit.objective }).filter(([, v]) => v !== undefined)));
  // A task is its owner's objective's, unless told otherwise.
  t.objective ??= edit.session ? sessions.get(edit.session)?.role?.objective : undefined;
  if (edit.session && !t.sessions.includes(edit.session)) t.sessions.push(edit.session);
  if (edit.link && !t.links.includes(edit.link)) t.links.push(edit.link);
  if (edit.event || moved) {
    t.timeline.push({ at, text: edit.event ?? `moved to ${t.status}`, ...(edit.session && { session: edit.session }) });
    t.timeline.sort((a, b) => a.at - b.at);
  }
  t.updated = Math.max(t.updated, at);
  saveTasks();
  return t;
}

// A task's column follows the agents still on it, those whose newest task it is: on the user while one is asleep on his answer, doing
// while one works, waiting while one is asleep on anyone else or its PRs are still open, done once all are done. A question needs its answer to be done.
// Done is final here: an agent's later work may be for something else, so only a new request filed on the task reopens it.
const DONE_ARCHIVE_MS = 3_600_000;
export const newestTaskOf = (id: string) => tasks.findLast((t) => t.sessions.includes(id) && t.status !== "dropped");
export function derive(t: Task): { to: Task["status"]; why: string } | null {
  const agents = t.sessions.flatMap((id) => sessions.get(id) ?? []).filter((s) => s.exitCode === null && isAgent(s) && newestTaskOf(s.id) === t);
  if (!agents.length) return null;
  const asking = agents.find((s) => s.wait?.kind === "thread" && threadOf(s.wait.ref)?.asks);
  if (asking) return { to: "you", why: `${asking.name} is asleep until you answer in thread ${asking.wait!.ref}` };
  // An agent with a message still to read is about to work, though its wait hasn't ended yet.
  const working = agents.find((s) => !s.wait || s.wait.awake || s.inbox.length);
  if (working) return { to: "doing", why: `${working.name} is working` };
  const asleep = agents.find((s) => s.wait!.kind !== "done");
  if (asleep) return { to: "waiting", why: `${asleep.name} waits on ${waitLabel(asleep.wait!)}` };
  const open = t.links.filter((u) => taskPrs()[u] === "OPEN").length;
  if (open) return { to: "waiting", why: `its agents are done and ${open === 1 ? "1 PR is" : `${open} PRs are`} still open` };
  if (t.kind === "question" && !t.answer) return null;
  return { to: "done", why: "every agent on it is done" };
}
export function settleTasks() {
  for (const t of tasks) {
    if (t.status === "blocked" || t.status === "dropped" || t.status === "done") continue;
    const d = derive(t);
    if (!d || d.to === t.derived) continue;
    t.derived = d.to;
    if (d.to === t.status) saveTasks();
    else editTask(t, { status: d.to, event: `${d.to === "done" ? "done" : `moved to ${d.to}`}: ${d.why}` });
    publish(`task/${t.id}`, { id: t.id, status: t.status, why: d.why });
  }
  // A done task's agents sleep an hour after it finished, keeping their last screen; a message still wakes them.
  for (const t of tasks)
    if (t.status === "done" && Date.now() - t.updated >= DONE_ARCHIVE_MS)
      for (const id of t.sessions) {
        const s = sessions.get(id);
        if (s && !s.archived && s.exitCode === null && s.wait?.kind === "done" && newestTaskOf(id) === t) setArchived(s, true);
      }
}

// Plain text of the visible pane plus `history` lines above it, trailing blank lines dropped.
export function screen(s: Session, history: number) {
  const live = s.exitCode === null && tmux("capture-pane", "-p", "-J", "-t", tmuxName(s.id), ...(history > 0 ? ["-S", String(-history)] : []));
  if (live && live.ok) return (s.lastScreen = live.out.trimEnd());
  // The pane is gone once the command exits; fall back to the last capture, else a rough strip of the raw stream.
  return s.lastScreen ?? new TextDecoder().decode(Buffer.concat(s.chunks)).replace(/\x1b\[[\d;]*[HfABCDG]/g, "\n").replace(/\x1b(\][^\x07]*\x07|\[[\d;?<>=]*[ -/]*[@-~]|[()][\w]|.)/g, "").replace(/\n\s*\n+/g, "\n").trimEnd();
}

// The text in claude's input box: from the `❯` line under the box's top border (which may carry the session's title, "──── Title ─")
// to the box's bottom border, and whether it is only dim placeholder text. Read without blocking, since a capture can take seconds under swap.
export async function inputBox(s: Session) {
  const lines = (await tmuxAsync("capture-pane", "-p", "-e", "-t", tmuxName(s.id))).out.split("\n");
  const plain = (l: string) => l.replace(/\x1b\[[\d;]*m/g, "");
  const border = (l: string) => /^─{10,}/.test(plain(l).trim());
  const i = lines.findLastIndex((l, j) => j > 0 && plain(l).startsWith("❯") && border(lines[j - 1]));
  if (i < 0) return null;
  const end = lines.findIndex((l, j) => j > i && border(l));
  const first = lines[i].slice(lines[i].indexOf("❯") + 1).replace(/^[\s\u00a0]+/, "");
  const text = lines.slice(i, end < 0 ? undefined : end).map(plain).join("\n").replace(/^❯/, "").trim();
  return { text, empty: first.startsWith("\x1b[2m") || text === "" };
}
