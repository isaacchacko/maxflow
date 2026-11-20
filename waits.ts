import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { peekStateJson, stateDirectory, writeStateJson } from "./state";
import { publish } from "./bus";
import { scoped, tmuxName } from "./tmux";
import { type Session, type Wait, sessions } from "./sessions";
import type { Shell } from "./model";
import { isLive, saveThreads, threads } from "./stores";
import { createSession, endWait, screen, setArchived, setWait, tellWaiters, threadOf, waitLabel, isWaitingOn } from "./lifecycle";
import { isFilled, isRecord } from "./shared/guards";

const finishToldByWaiterAndAgent = new Map<string, number>();
const isAtRest = (s: Session) => s.claude?.state !== "working" && s.claude?.state !== "waiting";
export function tellDone(on: Session) {
  const finish = on.wait?.at;
  for (const w of sessions.values()) {
    if (w === on || !isWaitingOn(w, on.id) || w.exitCode !== null || finishToldByWaiterAndAgent.get(`${w.id}>${on.id}`) === finish) continue;
    if (finish === undefined) return;
    finishToldByWaiterAndAgent.set(`${w.id}>${on.id}`, finish);
    endWait(w, `"${on.name}" (session ${on.id}) is now done`);
  }
}
function didEndOnAgentAlreadyDone(w: Session) {
  const awaited = w.wait?.kind === "agent" ? w.wait.ref.split(",") : [];
  for (const id of awaited) {
    const o = sessions.get(id);
    if (o?.wait?.kind !== "done" || !isAtRest(o) || finishToldByWaiterAndAgent.get(`${w.id}>${id}`) === o.wait.at) continue;
    finishToldByWaiterAndAgent.set(`${w.id}>${id}`, o.wait.at);
    endWait(w, `"${o.name}" (session ${o.id}) is already done`);
    return true;
  }
  return false;
}
const SHELLS = "shells.json";
const SHELL_DIR = stateDirectory("shells");
const SHELL_KEEP_MS = 7 * 86_400_000;
const FINISHED_COMMAND_PANE_KEEP_MS = 3_600_000;
const SHELL_TAIL_LINES = 30;
export const shells: Shell[] = (() => { try { return (peekStateJson(SHELLS) as Shell[]).filter((x) => !x.end || Date.now() - x.end.at < SHELL_KEEP_MS); } catch { return []; } })();
function saveShells() {
  writeStateJson(SHELLS, shells);
  publish("shells", { n: shells.length });
}
export function handShellsTo(from: string, to: string) {
  const running = shells.filter((x) => x.owner === from && x.end === undefined);
  for (const x of running) x.owner = to;
  if (running.length > 0) saveShells();
}
function addShell(x: Shell) {
  shells.push(x);
  saveShells();
  return x;
}
const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;
type ShellCommand = { desc: string; cmd: string; cwd: string; path?: string | undefined };
function shellScript({ cmd, path }: ShellCommand, codeFile: string) {
  return [
    ...(isFilled(path) ? [`export PATH=${quote(path)}`] : []),
    String.raw`printf '\033[2m$ %s\033[0m\n' ${quote(cmd)}`,
    `"\${SHELL:-/bin/sh}" -c ${quote(cmd)}`,
    "code=$?",
    `echo "$code" > ${quote(codeFile)}`,
    `printf '\\n\\033[2m[exited with code %s]\\033[0m\\n' "$code"`,
    "exec sleep 3600",
  ].join("\n");
}
function startShell(owner: Session, command: ShellCommand): Shell {
  mkdirSync(SHELL_DIR, { recursive: true });
  const token = crypto.randomUUID().slice(0, 8);
  const script = `${SHELL_DIR}/${token}.sh`;
  writeFileSync(script, shellScript(command, `${SHELL_DIR}/${token}.code`));
  const { desc, cmd, cwd } = command;
  const s = createSession(desc, ["sh", script], cwd);
  return addShell({ id: s.id, desc, owner: owner.id, kind: "cmd", cmd, cwd, file: `${SHELL_DIR}/${token}.code`, at: Date.now() });
}
function processEnded(pid: number | undefined): { code: number | null } | null {
  if (pid === undefined) return { code: null };
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    const failure: { code?: unknown } | undefined = isRecord(error) ? error : undefined;
    return failure?.code === "EPERM" ? null : { code: null };
  }
}
function shellEnded(x: Shell): { code: number | null } | null {
  if (x.kind === "pid") return processEnded(x.pid);
  const s = sessions.get(x.id);
  if (x.kind === "cmd" && x.file !== undefined && existsSync(x.file)) return { code: Number(readFileSync(x.file, "utf8").trim()) };
  return s?.exitCode === null ? null : { code: null };
}
function shellTail(x: Shell) {
  const s = sessions.get(x.id);
  if (!s) return "";
  const lines = screen(s, 500).split("\n").filter((l) => !/^\[exited with code \d+\]$/.test(l));
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  return lines.slice(-SHELL_TAIL_LINES).join("\n");
}
function howShellEnded(x: Shell, code: number | null) {
  if (code !== null) return `it exited with code ${code}`;
  return x.kind === "pid" ? `process ${String(x.pid)} exited` : "the session ended";
}
function endWaitsOnShell(x: Shell, end: NonNullable<Shell["end"]>) {
  const tail = end.tail === "" ? "" : `. Its last lines:\n\`\`\`\n${end.tail}\n\`\`\``;
  for (const s of sessions.values()) if (s.wait?.kind === "until" && s.wait.ref === x.id) endWait(s, `${howShellEnded(x, end.code)}${tail}`);
}
function closeFinishedCommandPanes() {
  for (const x of shells)
    if (x.kind === "cmd" && x.end && Date.now() - x.end.at > FINISHED_COMMAND_PANE_KEEP_MS && isLive(sessions.get(x.id))) scoped("kill-session", "-t", tmuxName(x.id));
}
export function checkShells() {
  let hasChanged = false;
  for (const x of shells) {
    if (x.end) continue;
    const ended = shellEnded(x);
    if (!ended) continue;
    x.end = { at: Date.now(), code: ended.code, tail: shellTail(x) };
    hasChanged = true;
    endWaitsOnShell(x, x.end);
  }
  closeFinishedCommandPanes();
  if (hasChanged) saveShells();
}
function paneShell(s: Session, desc: string, pane: string): Shell | string {
  const o = sessions.get(pane);
  if (!o || o === s || !isLive(o)) return `no other running session ${pane}`;
  return addShell({ id: o.id, desc, owner: s.id, kind: "pane", cwd: o.cwd, at: Date.now() });
}
function pidShell(s: Session, desc: string, pid: number): Shell | string {
  if (shellEnded({ id: "", desc, owner: s.id, kind: "pid", pid, at: 0 })) return `no process ${pid}`;
  return addShell({ id: `pid-${pid}-${Date.now().toString(36)}`, desc, owner: s.id, kind: "pid", pid, at: Date.now() });
}
export function untilShell(s: Session, body: { desc?: string; cmd?: string; cwd?: string; path?: string; pane?: string; pid?: number }): Shell | string {
  const desc = body.desc?.trim();
  if (!isFilled(desc)) return "until needs a description of what it waits for";
  const cmd = body.cmd?.trim();
  if (isFilled(cmd)) return startShell(s, { desc, cmd, cwd: isFilled(body.cwd) ? body.cwd : s.cwd, path: body.path });
  if (isFilled(body.pane)) return paneShell(s, desc, body.pane);
  if (body.pid !== undefined && body.pid !== 0) return pidShell(s, desc, body.pid);
  return "until needs a command (after --), --pane <session> or --pid <pid>";
}

type NamedWait = { kind: Wait["kind"]; ref: string; shell?: Shell };
const WAIT_KINDS: ReadonlySet<string> = new Set<Wait["kind"]>(["thread", "approval", "ci", "agent", "slack", "until", "done"]);
const isWaitKind = (kind: string): kind is Wait["kind"] => WAIT_KINDS.has(kind);
function threadOfQuestionFromBeforeThreads(ref: string): NamedWait | string {
  const t = threadOf(`q${ref.replace(/^q/, "")}`);
  if (!t) return `no question q${ref.replace(/^q/, "")}: questions are threads now, so wait on thread:<id>`;
  return { kind: "thread", ref: t.id };
}
function awaitedAgents(s: Session, ref: string): NamedWait | string {
  const ids = [...new Set(ref.split(/[\s,]+/).map((x) => x.replace(/^agent:/, "")).filter((x) => x !== ""))];
  const bad = ids.find((id) => {
    const o = sessions.get(id);
    return !o || o === s || o.exitCode !== null;
  });
  if (bad !== undefined) return `no other running session ${bad}`;
  return { kind: "agent", ref: ids.join(",") };
}
function declaredKindAndRef(kind: string, ref: string): NamedWait | string {
  if (kind === "q") return ref === "" ? "q needs a ref" : threadOfQuestionFromBeforeThreads(ref);
  if (!isWaitKind(kind)) return "kind must be thread, approval, ci, agent, slack, until or done";
  if (kind !== "done" && ref === "") return `${kind} needs a ref`;
  return { kind, ref };
}
function namedWait(s: Session, kind: string, ref: string): NamedWait | string {
  const named = declaredKindAndRef(kind, ref);
  if (typeof named === "string") return named;
  if (named.kind === "thread" && threads.every((o) => o.id !== named.ref)) return `no thread ${named.ref}`;
  if (named.kind === "until") {
    const shell = shells.find((x) => x.id === named.ref);
    return shell ? { ...named, shell } : `no shell ${named.ref}`;
  }
  return named.kind === "agent" ? awaitedAgents(s, named.ref) : named;
}
function tellWhoWaitsOn(s: Session, kind: Wait["kind"], was: Wait | undefined, isSameFinish: boolean) {
  if (kind === "done") {
    if (!isSameFinish && isAtRest(s)) tellDone(s);
    return;
  }
  const wait = s.wait;
  if (wait === undefined) return;
  if (!was || waitLabel(was) !== waitLabel(wait)) tellWaiters(s, `is now waiting on ${waitLabel(wait)}`);
}
const sameFinishAtOf = (kind: Wait["kind"], was: Wait | undefined) => (kind === "done" && was?.kind === "done" ? was.at : undefined);
function didEndOnShellAlreadyOver(s: Session, shell: Shell | undefined) {
  const end = shell?.end;
  if (!end) return false;
  endWait(s, `it had already ended${end.code === null ? "" : ` with code ${end.code}`}`);
  return true;
}
function sleepNowIfDeclaredBetweenTurns(s: Session, kind: Wait["kind"]) {
  if (kind !== "done" && s.claude?.state !== "working") setArchived(s, true);
}
export function declareWait(s: Session, kind: string, ref: string, desc?: string): string | null {
  const named = namedWait(s, kind, ref);
  if (typeof named === "string") return named;
  const was = s.wait;
  const sameFinishAt = sameFinishAtOf(named.kind, was);
  const isSameFinish = sameFinishAt !== undefined;
  const at = sameFinishAt ?? Date.now();
  setWait(s, { kind: named.kind, ref: named.kind === "done" ? "" : named.ref, at, ...(named.shell && { desc: desc ?? named.shell.desc }) });
  tellWhoWaitsOn(s, named.kind, was, isSameFinish);
  if (named.kind === "agent" && didEndOnAgentAlreadyDone(s)) return null;
  if (didEndOnShellAlreadyOver(s, named.shell)) return null;
  sleepNowIfDeclaredBetweenTurns(s, named.kind);
  return null;
}

const threadsAwaitingAnswerFrom = (s: Session) => threads.filter((t) => t.mergedInto === undefined && t.pending?.routers.includes(s.id) === true);
export function sayWhyInThreadsHeWaitsIn(s: Session, kind: string, why: string | undefined): string | null {
  if (kind === "done") return null;
  const waiting = threadsAwaitingAnswerFrom(s);
  if (waiting.length === 0) return null;
  if (!isFilled(why)) {
    const where = waiting.map((t) => `${t.id} ("${t.title}")`).join(", ");
    return `he is waiting on your answer in ${where}; add --why '<one line saying what you wait for and what you do once it lands>', which he reads in the thread while you sleep`;
  }
  for (const t of waiting) {
    if (t.pending) t.pending.status = why;
    publish(`thread/${t.id}`, { thread: t.id, status: why });
  }
  saveThreads();
  return null;
}
