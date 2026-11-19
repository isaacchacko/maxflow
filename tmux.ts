import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CLI, DIR, ARE_AGENTS_INERT, INSTANCE, PORT, TMUX_SCOPE, TMUX_SOCKET } from "./instance";
import { stateDisplayPath } from "./state";

const TMUX_SYNC_TIMEOUT_MS = 5000;
const MAX_INLINE_COMMAND_CHARS = 8000;
const OPTION_WRITES_PER_BATCH = 100;

// constraint: Claude Code's CLAUDECODE/CLAUDE_CODE_*/CLAUDE_PID markers make a child claude think it is a subagent
const CLAUDE_MARKERS_AND_SERVICE_ONLY_ENV = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|MAXFLOW_SENTRIES$)/;
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !CLAUDE_MARKERS_AND_SERVICE_ONLY_ENV.test(k)));
export const termEnv = { LANG: "en_US.UTF-8", ...childEnv, TERM: "xterm-256color", COLORTERM: "truecolor" };

export const TMUX = ["tmux", "-L", TMUX_SOCKET, "-f", new URL("tmux.conf", import.meta.url).pathname];
export const tmuxName = (id: string) => `mf-${id}`;
export const paneEnv = (id: string) => ["-e", `MAXFLOW_SESSION=${id}`, "-e", `MAXFLOW_PORT=${PORT}`, "-e", `MAXFLOW_INSTANCE=${INSTANCE}`, "-e", `MAXFLOW_STATE=${stateDisplayPath("")}`, "-e", `MAXFLOW_CLI=${CLI}`, "-e", `MAXFLOW_DIR=${DIR}`];

export function tmux(...args: string[]) {
  const r = Bun.spawnSync([...TMUX, ...args], { env: termEnv, timeout: TMUX_SYNC_TIMEOUT_MS });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString().trim() };
}
// constraint: tmux 3.7 crashes respawning a pane whose fork failed (pid -1, no input parser), so that pane gets a new window instead
export function respawn(id: string, ...args: string[]) {
  const t = tmuxName(id);
  const [pid, index] = tmux("display-message", "-p", "-t", t, "#{pane_pid} #{window_index}").out.trim().split(" ", 2);
  const r = pid === "-1" ? tmux("new-window", "-k", "-t", `${t}:${index}`, ...args) : tmux("respawn-pane", "-k", "-t", t, ...args);
  if (!r.ok) console.error(`${id}: respawning its pane failed: ${r.err}`);
  return r.ok;
}
export function scoped(...args: string[]) {
  const r = Bun.spawnSync([...TMUX_SCOPE, ...TMUX, ...args], { env: termEnv, timeout: TMUX_SYNC_TIMEOUT_MS });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}
// constraint: send-keys can wait on tmux flushing to attached clients, which drain only while the event loop runs
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
  const batch = [...pendingOptions].slice(0, OPTION_WRITES_PER_BATCH);
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
// constraint: a pane scrolled back is in tmux copy mode, which takes keys itself, so Enter there never reaches claude
async function leaveCopyMode(target: string) {
  if ((await tmuxAsync("display-message", "-p", "-t", target, "#{pane_in_mode}")).out.trim() === "1") await tmuxAsync("send-keys", "-t", target, "-X", "cancel");
}
export const pressEnter = async (target: string) => {
  await leaveCopyMode(target);
  return tmuxAsync("send-keys", "-t", target, "Enter");
};
// constraint: unbracketed text reaches the pane in ~1KB reads, which claude can take as a paste it never closes
export async function paste(target: string, text: string) {
  await leaveCopyMode(target);
  const load = Bun.spawn([...TMUX, "load-buffer", "-b", target, "-"], { env: termEnv, stdin: new Blob([text]) });
  await load.exited;
  await tmuxAsync("paste-buffer", "-p", "-d", "-b", target, "-t", target);
}

const withInertModel = (cmd: string[]) => (ARE_AGENTS_INERT && !cmd.includes("--model") ? ["claude", "--model", "haiku", ...cmd.slice(1)] : cmd);
export const named = (id: string, cmd: string[]) => {
  if (cmd[0] !== "claude") return cmd;
  const claude = withInertModel(cmd);
  return claude.includes("--name") ? claude : ["claude", "--name", `mf-${id}`, ...claude.slice(1)];
};
// constraint: tmux rejects a command over ~16KB ("command too long"), so a long one runs from a script that deletes itself
export function launchable(id: string, cmd: string[]) {
  const launched = named(id, cmd);
  if (launched.join(" ").length < MAX_INLINE_COMMAND_CHARS) return launched;
  const script = `${tmpdir()}/maxflow-launch-${id}.sh`;
  writeFileSync(script, `rm -f "$0"\nexec ${launched.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ")}\n`);
  return ["sh", script];
}
