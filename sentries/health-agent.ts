import { bothEnvNames } from "../shared/legacy-maxflow";
import { join } from "node:path";
import { TMUX_SCOPE, TMUX_SOCKET } from "../instance";
import { stateDirectory } from "../state";

export const IS_WATCHING_DEV_AS_IF_LIVE = (process.env["HEALTH_DEV"] ?? "") !== "";
export const DIR = join(import.meta.dir, "..");
export const TMUX = ["tmux", "-L", TMUX_SOCKET, "-f", join(DIR, "tmux.conf")];
const IDLE_TICKS = 3;
const INERT = "Reply with the single word ok, and do nothing else.";

export type Agent = { id: string; tmux: string; at: number };
const progressOf = new WeakMap<Agent, { wasWorking: boolean; idleTicks: number }>();

export const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd);
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
};
export const stamp = () => new Date().toLocaleTimeString();

export function startAgent(prompt: string): Agent {
  const id = crypto.randomUUID().slice(0, 8);
  const meta = { name: "yarn recovery", cmd: ["claude"], cwd: DIR, createdAt: Date.now() };
  const t = `mf-${id}`;
  const cwd = IS_WATCHING_DEV_AS_IF_LIVE ? stateDirectory("helper-cwd") : DIR;
  const claudeArgs = IS_WATCHING_DEV_AS_IF_LIVE ? ["--model", "haiku", INERT] : [prompt];
  const created = run([...TMUX_SCOPE, ...TMUX, "new-session", "-d", "-s", t, "-x", "120", "-y", "34", "-c", cwd, ...bothEnvNames("SESSION").flatMap((key) => ["-e", `${key}=${id}`]), "--", "claude", "--permission-mode", "bypassPermissions", ...claudeArgs]);
  if (!created.ok) throw new Error(`tmux new-session failed: ${created.out}`);
  run([...TMUX, "set-option", "-t", t, "@mf", JSON.stringify(meta)]);
  const agent = { id, tmux: t, at: Date.now() };
  progressOf.set(agent, { wasWorking: false, idleTicks: 0 });
  return agent;
}

export function hasFinished(agent: Agent) {
  const progress = progressOf.get(agent);
  return progress !== undefined && progress.wasWorking && progress.idleTicks >= IDLE_TICKS;
}
export const hasSession = (agent: Agent) => run([...TMUX, "has-session", "-t", agent.tmux]).ok;

export function isStillWorking(agent: Agent | null) {
  if (agent === null || !hasSession(agent)) return false;
  const screen = run([...TMUX, "capture-pane", "-p", "-t", agent.tmux]).out;
  const isWorking = /esc to interrupt/i.test(screen);
  const progress = progressOf.get(agent) ?? { wasWorking: false, idleTicks: 0 };
  progress.wasWorking ||= isWorking || /⏺|Worked for/.test(screen);
  progress.idleTicks = isWorking ? 0 : progress.idleTicks + 1;
  progressOf.set(agent, progress);
  return !hasFinished(agent);
}

export async function acceptTrustInFolderNotYetTrustedForThisSessionOnly(t: string) {
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1000);
    const screen = run([...TMUX, "capture-pane", "-p", "-t", t]).out;
    if (screen.includes("Yes, I trust this folder")) {
      run([...TMUX, "send-keys", "-t", t, "Down", "Enter"]);
      return;
    }
    if (/esc to interrupt|bypass permissions/i.test(screen)) return;
  }
}
