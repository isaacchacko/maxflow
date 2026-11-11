#!/usr/bin/env bun
// health sentry: when the maxflow server stays unreachable, starts a claude agent to find out why and bring it back.
// It runs in tmux, so it outlives the server it watches, and it starts the agent straight in tmux for the same reason;
// the server adopts that session like any other once it is back.
import { join } from "node:path";

const INTERVAL_MS = Number(process.env.HEALTH_INTERVAL ?? 15_000);
const DOWN_MS = Number(process.env.HEALTH_DOWN_MS ?? 120_000);
const COOLDOWN_MS = Number(process.env.HEALTH_COOLDOWN_MS ?? 15 * 60_000);
const LABEL = "com.isaacchacko.maxflow";
const LOG = "/tmp/maxflow.log";
const DIR = join(import.meta.dir, "..");
const TMUX = ["tmux", "-L", "maxflow", "-f", join(DIR, "tmux.conf")];
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd);
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
};
const launchd = () => run(["launchctl", "print", `gui/${process.getuid!()}/${LABEL}`]);

async function up() {
  try {
    return (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}

function startAgent(downSince: number) {
  const id = crypto.randomUUID().slice(0, 8);
  const status = launchd().out.split("\n").filter((l) => /state =|runs =|last exit|pid =/.test(l)).join("\n");
  const log = run(["tail", "-n", "80", LOG]).out;
  const prompt = `The maxflow server (${DIR}, launchd agent ${LABEL}, ${base}) has not answered since ${new Date(downSince).toLocaleTimeString()}, so the health sentry started you to bring it back.

launchd says:
${status}

Last lines of ${LOG}:
${log}

Find the root cause and fix it, then restart with \`launchctl kickstart -k gui/$(id -u)/${LABEL}\` and confirm \`curl -s ${base}/api/sessions\` answers. Other agents edit this repo with uncommitted work in the tree: fix the breakage in place rather than reverting or stashing their changes, and don't commit. Don't kill any tmux session on the maxflow socket; they are the user's running work. When it is back, say in a few lines what broke and what you changed.`;
  const meta = { name: "maxflow recovery", cmd: ["claude"], cwd: DIR, createdAt: Date.now() };
  const t = `mf-${id}`;
  const created = run([...TMUX, "new-session", "-d", "-s", t, "-x", "120", "-y", "34", "-c", DIR, "-e", `MAXFLOW_SESSION=${id}`, "--", "claude", "--permission-mode", "bypassPermissions", prompt]);
  if (!created.ok) throw new Error(`tmux new-session failed: ${created.out}`);
  run([...TMUX, "set-option", "-t", t, "@mf", JSON.stringify(meta)]);
  return t;
}

// The maxflow folder isn't a trusted claude workspace, so the agent opens on the trust dialog; accept it for this session only.
async function acceptTrust(t: string) {
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1000);
    const screen = run([...TMUX, "capture-pane", "-p", "-t", t]).out;
    if (/Yes, I trust this folder/.test(screen)) return void run([...TMUX, "send-keys", "-t", t, "Down", "Enter"]);
    if (/esc to interrupt|bypass permissions/i.test(screen)) return;
  }
}

console.log(`health sentry: polls ${base} every ${INTERVAL_MS / 1000}s, starts a recovery agent after ${DOWN_MS / 1000}s down`);
let downSince: number | null = null;
let agent: { tmux: string; at: number } | null = null;
for (;;) {
  try {
    if (await up()) {
      if (downSince) console.log(`${new Date().toLocaleTimeString()}  up again after ${Math.round((Date.now() - downSince) / 1000)}s`);
      downSince = null;
    } else if (!launchd().ok) {
      // Unloaded on purpose (launchctl bootout/unload), so it is meant to be down.
      downSince = null;
    } else {
      downSince ??= Date.now();
      const agentAlive = agent && run([...TMUX, "has-session", "-t", agent.tmux]).ok;
      if (Date.now() - downSince >= DOWN_MS && !agentAlive && (!agent || Date.now() - agent.at >= COOLDOWN_MS)) {
        agent = { tmux: startAgent(downSince), at: Date.now() };
        await acceptTrust(agent.tmux);
        console.log(`${new Date().toLocaleTimeString()}  down ${Math.round((Date.now() - downSince) / 1000)}s, started recovery agent in ${agent.tmux}`);
      }
    }
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
}
