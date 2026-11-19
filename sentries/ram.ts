#!/usr/bin/env bun
import { totalmem } from "node:os";
import { join } from "node:path";
import { BASE as base, TMUX_SOCKET } from "../instance";
import { isRecord } from "../shared/guards";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("ram");

const INTERVAL_MS = Number(process.env["RAM_INTERVAL"] ?? 15_000);
const MAX_PCT = Number(process.env["RAM_MAX_PCT"] ?? 1.5);
const GRACE_MS = 3000;
const isDryRun = process.env["RAM_DRY"] === "1";
const FETCH_MS = 10_000;
const TMUX = ["tmux", "-L", TMUX_SOCKET, "-f", join(import.meta.dir, "..", "tmux.conf")];

const CI_WORK_NOT_DEV_SERVERS = [
  /(^|[/\s])(vitest|jest|tsc|vue-tsc|eslint|oxlint|biome|knip|prettier|mypy|pyright|basedpyright|pytest|py\.test|pylint|ruff|playwright|cypress)(\.[cm]?js|\.py)?(\s|$)/,
  /\s-m (pytest|mypy|pylint|ruff)(\s|$)/,
  /(^|[/\s])(next|vite|turbo|tsup) build(\s|$)/,
  /(^|[/\s])(pnpm|npm|yarn|bun)( run| exec)? (test|lint|typecheck|type-check|check|build)(:\S*)?(\s|$)/,
  /(^|[/\s])(go (test|vet|build)|cargo (test|build|check|clippy))(\s|$)/,
];
const SHELL = /^(-?\/?\S*\/)?-?(zsh|bash|sh|fish|dash)(\s|$)/;

type Proc = { pid: number; ppid: number; rss: number; cmd: string };

function processes() {
  const out = Bun.spawnSync(["ps", "-Ao", "pid=,ppid=,rss=,command="]).stdout.toString();
  const procs = new Map<number, Proc>();
  for (const line of out.split("\n")) {
    const [, pid, ppid, rss, cmd = ""] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
    if (pid !== undefined) procs.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), rss: Number(rss) * 1024, cmd });
  }
  return procs;
}

function panes() {
  const out = Bun.spawnSync([...TMUX, "list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]).stdout.toString();
  const byPid = new Map<number, string>();
  for (const line of out.split("\n")) {
    const [name = "", pid = ""] = line.split(" ", 2);
    if (pid !== "" && name.startsWith("mf-")) byPid.set(Number(pid), name.slice(3));
  }
  return byPid;
}

const DEPLOY = /(^|\/)cli\.ts deploy(\s|$)/;
const isUnderDeploy = (p: Proc, procs: Map<number, Proc>) => {
  for (let q: Proc | undefined = p; q !== undefined && q.pid > 1; q = procs.get(q.ppid)) if (DEPLOY.test(q.cmd)) return true;
  return false;
};
const isCiWork = (p: Proc) => !SHELL.test(p.cmd) && !/(^|\/)claude(\s|$)/.test(p.cmd) && CI_WORK_NOT_DEV_SERVERS.some((re) => re.test(p.cmd));

function sessionOfNearestPane(p: Proc, procs: Map<number, Proc>, paneOf: Map<number, string>) {
  for (let q: Proc | undefined = p; q !== undefined && q.pid > 1; q = procs.get(q.ppid)) {
    const id = paneOf.get(q.pid);
    if (id !== undefined && id !== "") return id;
  }
  return null;
}

function subtree(root: number, procs: Map<number, Proc>) {
  const kids = new Map<number, number[]>();
  for (const p of procs.values()) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const pids: number[] = [];
  const stack = [root];
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    pids.push(pid);
    stack.push(...(kids.get(pid) ?? []));
  }
  return pids;
}

const didSignal = (pid: number, sig: NodeJS.Signals | 0) => {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
};
function signalEach(pids: number[], sig: NodeJS.Signals) {
  for (const pid of pids) didSignal(pid, sig);
}
const isAlive = (pid: number) => didSignal(pid, 0);
const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

type Session = { id: string; name: string; running: boolean; agent: boolean; sentry: boolean };
const isRunningAgent = (value: unknown): value is Session =>
  isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && value["running"] === true && value["agent"] === true && value["sentry"] !== true;

async function runningAgents() {
  const sessions: unknown = await (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(FETCH_MS) })).json();
  return new Map((Array.isArray(sessions) ? sessions.filter(isRunningAgent) : []).map((s) => [s.id, s]));
}

const isTopmostCiWork = (p: Proc, procs: Map<number, Proc>) => {
  const parent = procs.get(p.ppid);
  return isCiWork(p) && (parent === undefined || !isCiWork(parent)) && !isUnderDeploy(p, procs);
};

const post = async (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_MS) });

async function tick() {
  const agents = await runningAgents();
  const procs = processes();
  const paneOf = panes();
  const total = totalmem();

  const roots = procs.values().filter((p) => isTopmostCiWork(p, procs)).toArray();
  for (const root of roots) {
    const id = sessionOfNearestPane(root, procs, paneOf);
    const agent = id === null ? undefined : agents.get(id);
    if (agent === undefined) continue;
    const pids = subtree(root.pid, procs);
    const rss = pids.reduce((sum, pid) => sum + (procs.get(pid)?.rss ?? 0), 0);
    const pct = (rss / total) * 100;
    if (pct < MAX_PCT) continue;

    const cmd = root.cmd.replaceAll(/\s+/g, " ").slice(0, 200);
    console.log(`${new Date().toLocaleTimeString()}  ${isDryRun ? "would kill" : "killing"} ${agent.name} [${agent.id}] pid ${root.pid}: ${gb(rss)} (${pct.toFixed(1)}%)  ${cmd}`);
    if (isDryRun) continue;
    signalEach(pids, "SIGTERM");
    await Bun.sleep(GRACE_MS);
    signalEach(pids.filter(isAlive), "SIGKILL");

    const text = `[maxflow ram sentry] I killed \`${cmd}\` (pid ${root.pid}): it held ${gb(rss)}, ${pct.toFixed(1)}% of this machine's RAM, which every other agent shares. Don't run test, lint, typecheck or build suites locally. Commit and push to your PR (open it with \`gh pr create\` if there is none) so they run on the Blacksmith CI runners, then read the result with \`gh pr checks\` and \`gh run view --log-failed\`. A quick lint of a single file you just edited is fine.`;
    await post(`/api/sessions/${agent.id}/notify`, { text });
    await post("/api/events", { topic: `ram/killed/${agent.id}`, data: { pid: root.pid, cmd, rss, pct } });
  }
}

console.log(`ram sentry: every ${INTERVAL_MS / 1000}s kills agents' local CI work over ${MAX_PCT}% of ${gb(totalmem())} RAM${isDryRun ? " (dry run)" : ""}`);
for (;;) {
  try {
    await tick();
  } catch (error) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, error);
  }
  await Bun.sleep(INTERVAL_MS);
}
