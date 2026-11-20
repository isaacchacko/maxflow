import { publish } from "./bus";
import { CLI } from "./instance";
import { setOption } from "./tmux";
import { type Role, type Session, isAgent, isSentry, sessions } from "./sessions";
import type { Thread } from "./model";
import { saveTasks, saveThreads, tasks, threads } from "./stores";
import { createSession, dispatch, saveInbox, setWait, waitLabel } from "./lifecycle";
import { handOff, setRole } from "./objectives";
import { claudeForARoleNeverABareShellThatWouldDropHisThreadReplies } from "./routes-sessions";
import { acceptTrust } from "./routing";
import { handShellsTo } from "./waits";
import { readCommitWatches, readWatches, writeCommitWatches, writeWatches } from "./gh";
import * as slackRead from "./slack-read";
import { readStateJson, writeStateJson } from "./state";
import { percent } from "./context-fill";
import { patch } from "./patch";
import { isFilled, isRecord } from "./shared/guards";

const ASKS = "handoffs.json";
const ASK_AGAIN_AFTER_MS = 30 * 60_000;

type Ask = { at: number; tokens: number; window: number; note?: string };
const isAsks = (value: unknown): value is Record<string, Ask> => isRecord(value) && Object.values(value).every((a) => isRecord(a) && typeof a["at"] === "number");
const asks: Record<string, Ask> = readStateJson(ASKS, isAsks) ?? {};
const saveAsks = () => {
  writeStateJson(ASKS, asks);
};

const isMidTurn = (s: Session) => s.claude?.state === "working" || s.claude?.state === "waiting";
const k = (tokens: number) => `${String(Math.round(tokens / 1000))}k`;

export function successorOf(s: Session): Session {
  const seen = new Set<string>();
  let at = s;
  for (let next = sessions.get(at.role?.handedTo ?? ""); next && next.exitCode === null && !seen.has(next.id); next = sessions.get(at.role?.handedTo ?? "")) {
    seen.add(next.id);
    at = next;
  }
  return at;
}

function askRefusal(s: Session) {
  if (!isAgent(s) || isSentry(s) || s.exitCode !== null) return `${s.id} isn't a running agent`;
  if (s.role === undefined) return `${s.id} has no router or worker role to hand over`;
  if (isFilled(s.role.handedTo)) return `${s.id} already handed its work to ${s.role.handedTo}`;
  if (isMidTurn(s)) return `${s.id} is mid-turn; ask again at its idle prompt`;
  const asked = asks[s.id];
  return asked !== undefined && Date.now() - asked.at < ASK_AGAIN_AFTER_MS ? `${s.id} was asked for its hand-off note ${String(Math.round((Date.now() - asked.at) / 60_000))} min ago` : null;
}

export function askForHandoffNote(s: Session, tokens: number, window: number): string | null {
  const refusal = askRefusal(s);
  if (refusal !== null) return refusal;
  asks[s.id] = { at: Date.now(), tokens, window };
  saveAsks();
  const pct = percent({ tokens, window });
  dispatch({
    to: [s],
    target: "context hand-off",
    text: `[maxflow] Your context is ${String(pct)}% full (${k(tokens)} of ${k(window)} tokens), so maxflow is handing your work to a fresh agent before Claude Code compacts this chat. Write a hand-off note to a file: your goal and who asked for it, where it stands, what's left in order, the branch, worktree and PRs, what you're waiting on and why, and anything the next agent would otherwise have to rediscover (decisions made, dead ends, commands that work). Then run \`${CLI} handoff <file>\` and end your turn; don't declare a new wait. When the turn ends, maxflow starts the fresh agent in ${s.cwd} with your note, and moves your role, threads, task, watches and wait to it. Don't tell anyone; the hand-off shows itself.`,
  });
  publish(`handoff/asked/${s.id}`, { session: s.id, tokens, window, pct });
  return null;
}

export function noteHandoff(s: Session, note: string): string | null {
  if (s.role === undefined || isFilled(s.role.handedTo)) return "nothing to hand over: you have no role, or you already handed it on";
  asks[s.id] = { ...(asks[s.id] ?? { at: Date.now(), tokens: 0, window: 0 }), note };
  saveAsks();
  return null;
}

const without = (ids: string[], old: string, fresh: string) => [...new Set(ids.map((id) => (id === old ? fresh : id)))];

function moveThreadsStillNaming(old: Session, fresh: Session, line: string) {
  const moved: Thread[] = [];
  for (const t of threads) {
    if (t.mergedInto !== undefined) continue;
    const isNamed = t.routers.includes(old.id) || t.members?.includes(old.id) === true || t.pending?.routers.includes(old.id) === true || t.asks?.session === old.id;
    if (!isNamed) continue;
    t.routers = without(t.routers, old.id, fresh.id);
    if (t.members) t.members = without(t.members, old.id, fresh.id);
    if (t.pending) t.pending.routers = without(t.pending.routers, old.id, fresh.id);
    if (t.asks?.session === old.id) t.asks.session = fresh.id;
    t.messages.push({ id: `m-${crypto.randomUUID().slice(0, 6)}`, from: "maxflow", at: Date.now(), text: line });
    moved.push(t);
  }
  saveThreads();
  for (const t of moved) publish(`thread/${t.id}`, { thread: t.id, from: "maxflow" });
  return moved;
}

function moveTasks(old: Session, fresh: Session, line: string) {
  const moved = tasks.filter((t) => t.sessions.includes(old.id));
  for (const t of moved) {
    t.sessions = without(t.sessions, old.id, fresh.id);
    t.timeline.push({ at: Date.now(), text: line, session: fresh.id });
    t.updated = Date.now();
  }
  if (moved.length > 0) saveTasks();
  return moved;
}

function moveWatches(old: string, fresh: string) {
  writeWatches(readWatches().map((w) => ({ ...w, sessions: without(w.sessions, old, fresh) })));
  writeCommitWatches(readCommitWatches().map((w) => ({ ...w, sessions: without(w.sessions, old, fresh) })));
  slackRead.writeWatches(slackRead.readWatches().map((w) => ({ ...w, sessions: without(w.sessions, old, fresh) })));
}

function moveWaits(old: Session, fresh: Session) {
  if (old.wait !== undefined && old.wait.kind !== "done") setWait(fresh, { kind: old.wait.kind, ref: old.wait.ref, at: Date.now(), ...(old.wait.desc !== undefined && { desc: old.wait.desc }) });
  handShellsTo(old.id, fresh.id);
  for (const w of sessions.values())
    if (w.wait?.kind === "agent" && w.wait.ref.split(",").includes(old.id)) setWait(w, { ...w.wait, ref: without(w.wait.ref.split(","), old.id, fresh.id).join(",") });
  setWait(old, { kind: "done", ref: "", at: Date.now(), auto: true, desc: `handed to ${fresh.id}` });
}

function moveInbox(old: Session, fresh: Session) {
  if (old.inbox.length === 0) return;
  fresh.inbox.push(...old.inbox);
  old.inbox.length = 0;
  saveInbox(old);
  saveInbox(fresh);
}

function markHanded(old: Session) {
  patch(old, { name: `${old.name} · handed off`.slice(0, 80) });
  setOption(old.id, "@mf", JSON.stringify({ name: old.name, cmd: old.cmd, cwd: old.cwd, chatId: old.chatId, createdAt: old.createdAt }));
}

function startFresh(old: Session, role: Role) {
  const { handedTo: _to, handedFrom: _from, merged: _merged, ...kept } = role;
  const freshRole: Role = { ...kept, handedFrom: old.id };
  const cmd = claudeForARoleNeverABareShellThatWouldDropHisThreadReplies(freshRole);
  const fresh = createSession(old.name, cmd, old.cwd, { role: freshRole });
  void acceptTrust(fresh);
  return fresh;
}

export function completeHandoff(old: Session): Session | undefined {
  const ask = asks[old.id];
  const role = old.role;
  if (ask === undefined || !isFilled(ask.note) || role === undefined || isFilled(role.handedTo) || isMidTurn(old) || old.exitCode !== null) return undefined;
  const note = ask.note;
  const fresh = startFresh(old, role);
  const pct = ask.window > 0 ? `${String(percent(ask))}%` : undefined;
  const line = `Handed from [[agent:${old.id}]] to [[agent:${fresh.id}]]${pct === undefined ? "" : ` at ${pct} context`}, which carries this work from now on.`;
  if (role.role === "router") handOff(old, role, fresh, false);
  else setRole(old, { ...role, handedTo: fresh.id });
  const moved = moveThreadsStillNaming(old, fresh, line);
  const movedTasks = moveTasks(old, fresh, line.replaceAll(/\[\[agent:([\w-]+)\]\]/g, "$1"));
  moveWatches(old.id, fresh.id);
  moveWaits(old, fresh);
  moveInbox(old, fresh);
  markHanded(old);
  dispatch({
    to: [fresh],
    target: old.id,
    text: `[maxflow] You take over from "${fresh.name}" (${old.id}), whose context ${pct === undefined ? "was filling up" : `was ${pct} full`}. Its role, threads, task, and PR and Slack watches are yours now, and messages sent to it reach you.${fresh.wait ? ` Its wait on ${waitLabel(fresh.wait)} is already yours: don't declare it again; when this turn ends you sleep on it as it did.` : ""} Its transcript is ${old.transcript ?? "unknown"}, if the note leaves something out. Pick the work up from its note; don't announce the hand-off.\n\nIts hand-off note:\n\n${note}`,
  });
  Reflect.deleteProperty(asks, old.id);
  saveAsks();
  publish(`handoff/${old.id}`, { from: old.id, to: fresh.id, objective: role.objective, role: role.role, ...(ask.window > 0 && { tokens: ask.tokens, window: ask.window }), threads: moved.map((t) => t.id), tasks: movedTasks.map((t) => t.id) });
  return fresh;
}
