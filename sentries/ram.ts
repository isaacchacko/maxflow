#!/usr/bin/env bun
// ram sentry: kills the test, lint, typecheck and build jobs agents run locally once they hold too much memory,
// and tells the agent to run them on the Blacksmith CI runners through its PR instead.
import { totalmem } from "node:os";
import { join } from "node:path";

const INTERVAL_MS = Number(process.env.RAM_INTERVAL ?? 15_000);
const MAX_PCT = Number(process.env.RAM_MAX_PCT ?? 1.5);
const GRACE_MS = 3000;
const DRY = process.env.RAM_DRY === "1";
const TMUX = ["tmux", "-L", "maxflow", "-f", join(import.meta.dir, "..", "tmux.conf")];
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;

// Work CI already does on every push; dev servers like storybook or vite dev are left alone.
const CI_WORK = [
  /(^|[\/\s])(vitest|jest|tsc|vue-tsc|eslint|oxlint|biome|knip|prettier|mypy|pyright|basedpyright|pytest|py\.test|pylint|ruff|playwright|cypress)(\.[cm]?js|\.py)?(\s|$)/,
  /\s-m (pytest|mypy|pylint|ruff)(\s|$)/,
  /(^|[\/\s])(next|vite|turbo|tsup) build(\s|$)/,
  /(^|[\/\s])(pnpm|npm|yarn|bun)( run| exec)? (test|lint|typecheck|type-check|check|build)(:\S*)?(\s|$)/,
  /(^|[\/\s])(go (test|vet|build)|cargo (test|build|check|clippy))(\s|$)/,
];
const SHELL = /^(-?\/?\S*\/)?-?(zsh|bash|sh|fish|dash)(\s|$)/;

type Proc = { pid: number; ppid: number; rss: number; cmd: string };
type Session = { id: string; name: string; running: boolean; agent: boolean; sentry: boolean };

function processes() {
  const out = Bun.spawnSync(["ps", "-Ao", "pid=,ppid=,rss=,command="]).stdout.toString();
  const procs = new Map<number, Proc>();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.set(+m[1], { pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, cmd: m[4] });
  }
  return procs;
}

function panes() {
  const out = Bun.spawnSync([...TMUX, "list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]).stdout.toString();
  const byPid = new Map<number, string>();
  for (const line of out.split("\n")) {
    const [name, pid] = line.split(" ");
    if (name?.startsWith("mf-") && pid) byPid.set(+pid, name.slice(3));
  }
  return byPid;
}

const isCiWork = (p: Proc) => !SHELL.test(p.cmd) && !/(^|\/)claude(\s|$)/.test(p.cmd) && CI_WORK.some((re) => re.test(p.cmd));

// The agent session a process runs under, found by walking up to its tmux pane.
function owner(p: Proc, procs: Map<number, Proc>, paneOf: Map<number, string>) {
  for (let q: Proc | undefined = p; q && q.pid > 1; q = procs.get(q.ppid)) {
    const id = paneOf.get(q.pid);
    if (id) return id;
  }
  return null;
}

function subtree(root: number, procs: Map<number, Proc>) {
  const kids = new Map<number, number[]>();
  for (const p of procs.values()) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const pids: number[] = [];
  for (const stack = [root]; stack.length; ) {
    const pid = stack.pop()!;
    pids.push(pid);
    stack.push(...(kids.get(pid) ?? []));
  }
  return pids;
}

const signal = (pids: number[], sig: NodeJS.Signals) => {
  for (const pid of pids) try { process.kill(pid, sig); } catch {}
};
const alive = (pid: number) => {
  try { return process.kill(pid, 0), true; } catch { return false; }
};
const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

async function tick() {
  const sessions = ((await (await fetch(`${base}/api/sessions`)).json()) as Session[]).filter((s) => s.running && s.agent && !s.sentry);
  const agents = new Map(sessions.map((s) => [s.id, s]));
  const procs = processes();
  const paneOf = panes();
  const total = totalmem();

  // A job's root is its topmost CI-work ancestor, so a wrapper like `pnpm exec vitest` dies with the vitest it started.
  const roots = [...procs.values()].filter((p) => isCiWork(p) && !(procs.get(p.ppid) && isCiWork(procs.get(p.ppid)!)));
  for (const root of roots) {
    const id = owner(root, procs, paneOf);
    const agent = id && agents.get(id);
    if (!agent) continue;
    const pids = subtree(root.pid, procs);
    const rss = pids.reduce((sum, pid) => sum + (procs.get(pid)?.rss ?? 0), 0);
    const pct = (rss / total) * 100;
    if (pct < MAX_PCT) continue;

    const cmd = root.cmd.replace(/\s+/g, " ").slice(0, 200);
    console.log(`${new Date().toLocaleTimeString()}  ${DRY ? "would kill" : "killing"} ${agent.name} [${agent.id}] pid ${root.pid}: ${gb(rss)} (${pct.toFixed(1)}%)  ${cmd}`);
    if (DRY) continue;
    signal(pids, "SIGTERM");
    await Bun.sleep(GRACE_MS);
    signal(pids.filter(alive), "SIGKILL");

    const text = `[maxflow ram sentry] I killed \`${cmd}\` (pid ${root.pid}): it held ${gb(rss)}, ${pct.toFixed(1)}% of this machine's RAM, which every other agent shares. Don't run test, lint, typecheck or build suites locally. Commit and push to your PR (open it with \`gh pr create\` if there is none) so they run on the Blacksmith CI runners, then read the result with \`gh pr checks\` and \`gh run view --log-failed\`. A quick lint of a single file you just edited is fine.`;
    await fetch(`${base}/api/sessions/${agent.id}/notify`, { method: "POST", body: JSON.stringify({ text }) });
    await fetch(`${base}/api/events`, { method: "POST", body: JSON.stringify({ topic: `ram/killed/${agent.id}`, data: { pid: root.pid, cmd, rss, pct } }) });
  }
}

console.log(`ram sentry: every ${INTERVAL_MS / 1000}s kills agents' local CI work over ${MAX_PCT}% of ${gb(totalmem())} RAM${DRY ? " (dry run)" : ""}`);
for (;;) {
  try {
    await tick();
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
}
