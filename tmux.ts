import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CLI, DIR, INERT_AGENTS, INSTANCE, PORT, STATE_DIR, TMUX_SCOPE, TMUX_SOCKET } from "./instance";

// If maxflow itself was launched from a Claude Code session, its markers would make every child claude think it's a subagent.
// MAXFLOW_SENTRIES is the service's own: a pane that inherited it baked it into the plist on `maxflow install`, and the
// server then respawned only those sentries.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|MAXFLOW_SENTRIES$)/.test(k)));
export const termEnv = { LANG: "en_US.UTF-8", ...childEnv, TERM: "xterm-256color", COLORTERM: "truecolor" };

// Commands live in tmux sessions on a private socket so they survive server restarts; maxflow only attaches to them.
export const TMUX = ["tmux", "-L", TMUX_SOCKET, "-f", new URL("./tmux.conf", import.meta.url).pathname];
export const tmuxName = (id: string) => `mf-${id}`;
// Set on every pane, so its agents, hooks and cli.ts reach this instance even when the tmux server was started from another environment.
export const paneEnv = (id: string) => ["-e", `MAXFLOW_SESSION=${id}`, "-e", `MAXFLOW_PORT=${PORT}`, "-e", `MAXFLOW_INSTANCE=${INSTANCE}`, "-e", `MAXFLOW_STATE=${STATE_DIR}`, "-e", `MAXFLOW_CLI=${CLI}`, "-e", `MAXFLOW_DIR=${DIR}`];

// Sync calls block the event loop, which owns the attach clients' ptys; the timeout keeps a stalled tmux from wedging the server.
export function tmux(...args: string[]) {
  const r = Bun.spawnSync([...TMUX, ...args], { env: termEnv, timeout: 5000 });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr?.toString().trim() ?? "" };
}
// tmux 3.7 frees a pane's input parser before forking its new process and makes a new one only once the fork succeeds, so a failed
// fork (out of processes or ptys) leaves the pane at pid -1 with no parser. Respawning that pane frees the parser again and crashes
// the tmux server, which ended every session on the socket on 2026-11-18 at 16:16. Such a pane gets a fresh window in its place.
export function respawn(id: string, ...args: string[]) {
  const t = tmuxName(id);
  const [pid, index] = tmux("display-message", "-p", "-t", t, "#{pane_pid} #{window_index}").out.trim().split(" ");
  const r = pid === "-1" ? tmux("new-window", "-k", "-t", `${t}:${index}`, ...args) : tmux("respawn-pane", "-k", "-t", t, ...args);
  if (!r.ok) console.error(`${id}: respawning its pane failed: ${r.err}`);
  return r.ok;
}
// Creating a session may start the tmux server, which must not belong to the maxflow service (see TMUX_SCOPE).
export function scoped(...args: string[]) {
  const r = Bun.spawnSync([...TMUX_SCOPE, ...TMUX, ...args], { env: termEnv, timeout: 5000 });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}
// send-keys can wait on tmux flushing to attached clients, which only drain while the event loop runs, so it must not block.
export async function tmuxAsync(...args: string[]) {
  const p = Bun.spawn([...TMUX, ...args], { env: termEnv, stdout: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { ok: code === 0, out };
}
const pendingOptions = new Map<string, string[]>();
const optionQueue = { isDraining: false };
export function setOption(id: string, key: string, value: string) {
  pendingOptions.set(`${id} ${key}`, ["set-option", "-t", tmuxName(id), key, value]);
  if (!optionQueue.isDraining) void drainOptions();
}
const chained = (writes: string[][]) => writes.flatMap((w, i) => (i === 0 ? w : [";", ...w]));
function takeOptions() {
  const batch = [...pendingOptions].slice(0, 100);
  for (const [key] of batch) pendingOptions.delete(key);
  return batch.map(([, write]) => write);
}
async function drainOptions() {
  optionQueue.isDraining = true;
  for (let writes = takeOptions(); writes.length > 0; writes = takeOptions()) {
    const batch = await tmuxAsync(...chained(writes));
    if (!batch.ok) for (const w of writes) await tmuxAsync(...w);
  }
  optionQueue.isDraining = false;
}
export function flushOptions() {
  for (let writes = takeOptions(); writes.length > 0; writes = takeOptions())
    if (!tmux(...chained(writes)).ok) for (const w of writes) tmux(...w);
}
// A pane scrolled back in the browser is in tmux's copy mode, which takes keys for itself: Enter there never reaches claude, so a
// pasted message sat unsent while the log called it delivered. Whatever the server types leaves that mode first.
async function leaveMode(target: string) {
  if ((await tmuxAsync("display-message", "-p", "-t", target, "#{pane_in_mode}")).out.trim() === "1") await tmuxAsync("send-keys", "-t", target, "-X", "cancel");
}
export const pressEnter = async (target: string) => (await leaveMode(target), await tmuxAsync("send-keys", "-t", target, "Enter"));
// Unbracketed text reaches the pane in ~1KB reads, and claude can read the split as a paste it never closes, after which Enter only adds newlines.
export async function paste(target: string, text: string) {
  await leaveMode(target);
  const load = Bun.spawn([...TMUX, "load-buffer", "-b", target, "-"], { env: termEnv, stdin: new Blob([text]) });
  await load.exited;
  await tmuxAsync("paste-buffer", "-p", "-d", "-b", target, "-t", target);
}

// tmux rejects a command over ~16KB ("command too long"), so a long one (an agent's prompt) runs from a script that deletes itself.
// A claude is named mf-<id> natively, so agents address each other with SendMessage by their maxflow id.
// A dev instance's claudes run haiku unless asked for another model (INERT_AGENTS).
export const named = (id: string, cmd: string[]) => {
  if (cmd[0] !== "claude") return cmd;
  if (INERT_AGENTS && !cmd.includes("--model")) cmd = [cmd[0], "--model", "haiku", ...cmd.slice(1)];
  return cmd.includes("--name") ? cmd : [cmd[0], "--name", `mf-${id}`, ...cmd.slice(1)];
};
export function launchable(id: string, cmd: string[]) {
  cmd = named(id, cmd);
  if (cmd.join(" ").length < 8000) return cmd;
  const script = `${tmpdir()}/maxflow-launch-${id}.sh`;
  writeFileSync(script, `rm -f "$0"\nexec ${cmd.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ")}\n`);
  return ["sh", script];
}
