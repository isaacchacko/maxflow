import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { peekStateJson, stateDirectory, writeStateJson } from "./state";
import { publish } from "./bus";
import { scoped, tmuxName } from "./tmux";
import { type Session, type Wait, sessions } from "./sessions";
import type { Shell } from "./model";
import { live, threads } from "./stores";
import { createSession, endWait, screen, setArchived, setWait, tellWaiters, threadOf, waitLabel, waitsOn } from "./lifecycle";

// An agent's finish is told to each agent waiting on it once: when it comes to rest done (its turn over with `wait done` declared,
// or the auto done), or at once when the wait is declared on an agent at rest done. Done but mid-turn (a turn a peer's message started
// keeps its done) is not finished: that turn's end is a finish of its own. toldDone keeps, per waiter and agent, the finish (that
// agent's wait.at) it was told of, so a waiter that waits again on the same finish sleeps until the next one.
const toldDone = new Map<string, number>();
const atRest = (s: Session) => s.claude?.state !== "working" && s.claude?.state !== "waiting";
export function tellDone(on: Session) {
  for (const w of sessions.values()) {
    if (w === on || !waitsOn(w, on.id) || w.exitCode !== null || toldDone.get(`${w.id}>${on.id}`) === on.wait?.at) continue;
    toldDone.set(`${w.id}>${on.id}`, on.wait!.at);
    endWait(w, `"${on.name}" (session ${on.id}) is now done`);
  }
}
// Waiting on agents of which one is already done with a finish this waiter wasn't told of: that is its answer.
function alreadyDone(w: Session) {
  for (const id of w.wait?.kind === "agent" ? w.wait.ref.split(",") : []) {
    const o = sessions.get(id);
    if (o?.wait?.kind !== "done" || !atRest(o) || toldDone.get(`${w.id}>${id}`) === o.wait.at) continue;
    toldDone.set(`${w.id}>${id}`, o.wait.at);
    endWait(w, `"${o.name}" (session ${o.id}) is already done`);
    return true;
  }
  return false;
}
const SHELLS = "shells.json";
const SHELL_DIR = stateDirectory("shells");
const SHELL_KEEP_MS = 7 * 86_400_000;
const SHELL_TAIL_LINES = 30;
export const shells: Shell[] = (() => { try { return (peekStateJson(SHELLS) as Shell[]).filter((x) => !x.end || Date.now() - x.end.at < SHELL_KEEP_MS); } catch { return []; } })();
const saveShells = () => (writeStateJson(SHELLS, shells), publish("shells", { n: shells.length }));
const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;
function startShell(owner: Session, desc: string, cmd: string, cwd: string, path?: string): Shell {
  mkdirSync(SHELL_DIR, { recursive: true });
  const token = crypto.randomUUID().slice(0, 8);
  const script = `${SHELL_DIR}/${token}.sh`;
  writeFileSync(script, [
    ...(path ? [`export PATH=${quote(path)}`] : []),
    `printf '\\033[2m$ %s\\033[0m\\n' ${quote(cmd)}`,
    `"\${SHELL:-/bin/sh}" -c ${quote(cmd)}`,
    "code=$?",
    `echo "$code" > ${quote(`${SHELL_DIR}/${token}.code`)}`,
    `printf '\\n\\033[2m[exited with code %s]\\033[0m\\n' "$code"`,
    "exec sleep 3600",
  ].join("\n"));
  const s = createSession(desc, ["sh", script], cwd);
  const shell: Shell = { id: s.id, desc, owner: owner.id, kind: "cmd", cmd, cwd, file: `${SHELL_DIR}/${token}.code`, at: Date.now() };
  return shells.push(shell), saveShells(), shell;
}
function shellEnded(x: Shell): { code: number | null } | null {
  if (x.kind === "pid") {
    try { process.kill(x.pid!, 0); return null; } catch (e) { return (e as { code?: string }).code === "EPERM" ? null : { code: null }; }
  }
  const s = sessions.get(x.id);
  if (x.kind === "cmd") {
    if (existsSync(x.file!)) return { code: Number(readFileSync(x.file!, "utf8").trim()) };
  }
  return !s || s.exitCode !== null ? { code: null } : null;
}
function shellTail(x: Shell) {
  const s = sessions.get(x.id);
  if (!s) return "";
  const lines = screen(s, 500).split("\n").filter((l) => !/^\[exited with code \d+\]$/.test(l));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.slice(-SHELL_TAIL_LINES).join("\n");
}
export function checkShells() {
  let changed = false;
  for (const x of shells) {
    if (x.end) continue;
    const ended = shellEnded(x);
    if (!ended) continue;
    x.end = { at: Date.now(), code: ended.code, tail: shellTail(x) };
    changed = true;
    const how = x.end.code === null ? (x.kind === "pid" ? `process ${x.pid} exited` : "the session ended") : `it exited with code ${x.end.code}`;
    const tail = x.end.tail ? `. Its last lines:\n\`\`\`\n${x.end.tail}\n\`\`\`` : "";
    for (const s of sessions.values()) if (s.wait?.kind === "until" && s.wait.ref === x.id) endWait(s, `${how}${tail}`);
  }
  // A finished command's pane closes after its hour; the record (and its tail) stays a week.
  for (const x of shells) if (x.kind === "cmd" && x.end && Date.now() - x.end.at > 3_600_000 && live(sessions.get(x.id))) scoped("kill-session", "-t", tmuxName(x.id));
  if (changed) saveShells();
}
// What `wait until` names: a new command, a maxflow session already running, or a process; the error when it can't.
export function untilShell(s: Session, body: { desc?: string; cmd?: string; cwd?: string; path?: string; pane?: string; pid?: number }): Shell | string {
  const desc = body.desc?.trim();
  if (!desc) return "until needs a description of what it waits for";
  if (body.cmd?.trim()) return startShell(s, desc, body.cmd.trim(), body.cwd || s.cwd, body.path);
  if (body.pane) {
    const o = sessions.get(body.pane);
    if (!o || o === s || !live(o)) return `no other running session ${body.pane}`;
    const x: Shell = { id: o.id, desc, owner: s.id, kind: "pane", cwd: o.cwd, at: Date.now() };
    return shells.push(x), saveShells(), x;
  }
  if (body.pid) {
    if (shellEnded({ id: "", desc, owner: s.id, kind: "pid", pid: body.pid, at: 0 })) return `no process ${body.pid}`;
    const x: Shell = { id: `pid-${body.pid}-${Date.now().toString(36)}`, desc, owner: s.id, kind: "pid", pid: body.pid, at: Date.now() };
    return shells.push(x), saveShells(), x;
  }
  return "until needs a command (after --), --pane <session> or --pid <pid>";
}

export function declareWait(s: Session, kind: string, ref: string, desc?: string): string | null {
  if (!["thread", "q", "approval", "ci", "agent", "slack", "until", "done"].includes(kind)) return "kind must be thread, approval, ci, agent, slack, until or done";
  // done is always allowed: it keeps the agent awake, and the sentries still tell it about its open PRs and questions.
  if (kind !== "done" && !ref) return `${kind} needs a ref`;
  // q:<n>, the wait on a question from before threads, means the thread that question moved into.
  if (kind === "q") {
    const t = threadOf(`q${ref.replace(/^q/, "")}`);
    if (!t) return `no question q${ref.replace(/^q/, "")}: questions are threads now, so wait on thread:<id>`;
    (kind = "thread"), (ref = t.id);
  }
  if (kind === "thread" && !threads.some((o) => o.id === ref)) return `no thread ${ref}`;
  const shell = kind === "until" ? shells.find((x) => x.id === ref) : undefined;
  if (kind === "until" && !shell) return `no shell ${ref}`;
  if (kind === "agent") {
    const ids = [...new Set(ref.split(/[\s,]+/).map((x) => x.replace(/^agent:/, "")).filter(Boolean))];
    const bad = ids.find((id) => { const o = sessions.get(id); return !o || o === s || o.exitCode !== null; });
    if (bad) return `no other running session ${bad}`;
    ref = ids.join(",");
  }
  // Done again while done is the same finish: it keeps its time, and nobody is told again.
  const was = s.wait;
  const again = kind === "done" && was?.kind === "done";
  setWait(s, { kind: kind as Wait["kind"], ref: kind === "done" ? "" : ref, at: again ? was.at : Date.now(), ...(shell && { desc: desc ?? shell.desc }) });
  // Declared mid-turn, as it usually is, the finish is told when the turn ends (afterTurn).
  if (kind === "done") again || !atRest(s) || tellDone(s);
  else if (!was || waitLabel(was) !== waitLabel(s.wait!)) tellWaiters(s, `is now waiting on ${waitLabel(s.wait!)}`);
  if (kind === "agent" && alreadyDone(s)) return null;
  // A shell already over (a quick command, or one waited on again) is answered at the next check.
  if (shell?.end) return void endWait(s, `it had already ended${shell.end.code === null ? "" : ` with code ${shell.end.code}`}`), null;
  // Declared between turns, it sleeps at once; mid-turn, the Stop hook puts it to sleep.
  if (kind !== "done" && s.claude?.state !== "working") setArchived(s, true);
  return null;
}
