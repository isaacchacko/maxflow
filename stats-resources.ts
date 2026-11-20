import { totalmem } from "node:os";
import { basename } from "node:path";
import { TMUX_SOCKET } from "./instance";
import { isAgent, isSentry, sessions } from "./sessions";
import { stateDirectory } from "./state";
import { TMUX, tmuxName } from "./tmux";

type Proc = { pid: number; ppid: number; rssKb: number; cpu: number; args: string };
type Usage = { rssMb: number; cpu: number };
export type ProcRow = Usage & { pid: number; name: string };
export type ResourceGroup = Usage & { id: string; name: string; kind: "server" | "agent" | "sentry" | "shell"; chrome?: Usage; procs: ProcRow[]; history: number[] };
type Machine = { totalMb: number; usedMb: number; swapUsedMb: number; swapTotalMb: number };
type Sample = { at: number; rssMb: number; cpu: number; usedMb: number; swapUsedMb: number };
export type Resources = { at: number; everyMs: number; total: Usage; machine: Machine; groups: ResourceGroup[]; samples: Sample[] };

const EVERY_MS = 5000;
const KEPT_MS = 3_600_000;
const PS_TIMEOUT_MS = 4000;
const PROCS_SHOWN = 8;
const MB = 1024;
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/;
const SWAP_FIELD = (name: string) => new RegExp(`${name} = ([\\d.]+)M`);
const CHROME = /Google Chrome|Chromium|\/chrome(\s|$)/;
const CHROME_TYPE = /--type=([\w-]+)/;
const INTERPRETERS = new Set(["node", "bun", "python", "python3", "deno", "sh", "bash", "zsh"]);

const sampled: { latest: Resources | undefined; samples: Sample[]; history: Map<string, { at: number; rssMb: number }[]>; isRunning: boolean; ownPids: Set<number> } = {
  latest: undefined,
  samples: [],
  history: new Map(),
  isRunning: false,
  ownPids: new Set(),
};

async function output(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  sampled.ownPids.add(p.pid);
  const timer = setTimeout(() => p.kill(9), PS_TIMEOUT_MS);
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  clearTimeout(timer);
  return code === 0 ? out : "";
}

function parsePs(out: string) {
  const procs = new Map<number, Proc>();
  for (const line of out.split("\n")) {
    const m = PS_ROW.exec(line);
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), cpu: Number(m[4]), args: m[5] ?? "" });
  }
  return procs;
}

function nameOf(args: string) {
  if (CHROME.test(args)) {
    const type = CHROME_TYPE.exec(args)?.[1];
    return type === undefined ? "chrome" : `chrome ${type}`;
  }
  const [first = "", second = ""] = args.split(" ", 2);
  const program = basename(first).replace(/^-/, "");
  return INTERPRETERS.has(program) && second !== "" && !second.startsWith("-") ? `${program} ${basename(second)}` : program;
}

function childrenOf(procs: Map<number, Proc>) {
  const children = new Map<number, number[]>();
  for (const p of procs.values()) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  return children;
}

function subtree(root: number, children: Map<number, number[]>, skip: Set<number>) {
  const found: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || skip.has(pid)) continue;
    found.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return found;
}

const round = (n: number) => Math.round(n * 10) / 10;

function usageOf(pids: number[], procs: Map<number, Proc>): Usage {
  let rssKb = 0;
  let cpu = 0;
  for (const pid of pids) {
    const p = procs.get(pid);
    rssKb += p?.rssKb ?? 0;
    cpu += p?.cpu ?? 0;
  }
  return { rssMb: Math.round(rssKb / MB), cpu: round(cpu) };
}

function procRows(pids: number[], procs: Map<number, Proc>): ProcRow[] {
  return pids
    .flatMap((pid) => {
      const p = procs.get(pid);
      return p ? [{ pid, name: nameOf(p.args), rssMb: Math.round(p.rssKb / MB), cpu: round(p.cpu) }] : [];
    })
    .toSorted((a, b) => b.rssMb - a.rssMb)
    .slice(0, PROCS_SHOWN);
}

function chromeRootsBySession(procs: Map<number, Proc>) {
  const marker = `--user-data-dir=${stateDirectory("browsers")}/`;
  const roots = new Map<string, number>();
  for (const p of procs.values()) {
    const at = p.args.indexOf(marker);
    if (at === -1 || procs.get(p.ppid)?.args.includes(marker) === true) continue;
    const session = p.args.slice(at + marker.length).split(/[\s/]/, 1)[0] ?? "";
    if (session !== "") roots.set(session, p.pid);
  }
  return roots;
}

async function panePids() {
  const out = await output([...TMUX, "list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]);
  const panes = new Map<string, number>();
  for (const line of out.split("\n")) {
    const [name = "", pid = ""] = line.split(" ", 2);
    if (name !== "" && Number(pid) > 0) panes.set(name, Number(pid));
  }
  return panes;
}

async function machine(): Promise<Machine> {
  const totalMb = Math.round(totalmem() / MB / MB);
  if (process.platform === "linux") {
    const info = await Bun.file("/proc/meminfo").text();
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0);
    return { totalMb, usedMb: Math.round((kb("MemTotal") - kb("MemAvailable")) / MB), swapUsedMb: Math.round((kb("SwapTotal") - kb("SwapFree")) / MB), swapTotalMb: Math.round(kb("SwapTotal") / MB) };
  }
  const [vm, swap] = await Promise.all([output(["vm_stat"]), output(["sysctl", "-n", "vm.swapusage"])]);
  const pageBytes = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 16_384);
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
  const availableMb = ((pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * pageBytes) / MB / MB;
  return {
    totalMb,
    usedMb: Math.round(totalMb - availableMb),
    swapUsedMb: Math.round(Number(SWAP_FIELD("used").exec(swap)?.[1] ?? 0)),
    swapTotalMb: Math.round(Number(SWAP_FIELD("total").exec(swap)?.[1] ?? 0)),
  };
}

function kindOf(id: string): ResourceGroup["kind"] {
  const s = sessions.get(id);
  if (s === undefined) return "shell";
  if (isSentry(s)) return "sentry";
  return isAgent(s) ? "agent" : "shell";
}

function groupsOf(procs: Map<number, Proc>, panes: Map<string, number>) {
  const children = childrenOf(procs);
  const chromes = chromeRootsBySession(procs);
  const chromePids = new Set(chromes.values());
  const panePidSet = new Set(panes.values());
  const groups: Omit<ResourceGroup, "history">[] = [];
  for (const [id, s] of sessions) {
    const pane = panes.get(tmuxName(id));
    const chrome = chromes.get(id);
    if (pane === undefined && chrome === undefined) continue;
    const own = pane === undefined ? [] : subtree(pane, children, chromePids);
    const chromeTree = chrome === undefined ? [] : subtree(chrome, children, new Set());
    const all = [...own, ...chromeTree];
    groups.push({ id, name: s.name, kind: kindOf(id), ...usageOf(all, procs), ...(chrome !== undefined && { chrome: usageOf(chromeTree, procs) }), procs: procRows(all, procs) });
  }
  const tmuxServers = procs
    .values()
    .filter((p) => p.ppid === 1 && p.args.startsWith("tmux") && p.args.includes(`-L ${TMUX_SOCKET} `))
    .map((p) => p.pid)
    .toArray();
  const server = [...subtree(process.pid, children, new Set([...chromePids, ...panePidSet, ...sampled.ownPids])), ...tmuxServers];
  groups.push({ id: "server", name: "yarn server", kind: "server", ...usageOf(server, procs), procs: procRows(server, procs) });
  return groups.toSorted((a, b) => b.rssMb - a.rssMb);
}

function remember(groups: Omit<ResourceGroup, "history">[], at: number): ResourceGroup[] {
  const since = at - KEPT_MS;
  const live = new Set(groups.map((g) => g.id));
  for (const id of sampled.history.keys()) if (!live.has(id)) sampled.history.delete(id);
  return groups.map((g) => {
    const kept = [...(sampled.history.get(g.id) ?? []).filter((h) => h.at > since), { at, rssMb: g.rssMb }];
    sampled.history.set(g.id, kept);
    return { ...g, history: kept.map((h) => h.rssMb) };
  });
}

async function sample() {
  const [ps, panes, mem] = await Promise.all([output(["ps", "-A", "-o", "pid=,ppid=,rss=,%cpu=,args="]), panePids(), machine()]);
  const procs = parsePs(ps);
  if (procs.size === 0) return;
  const at = Date.now();
  const groups = remember(groupsOf(procs, panes), at);
  const total = { rssMb: groups.reduce((n, g) => n + g.rssMb, 0), cpu: round(groups.reduce((n, g) => n + g.cpu, 0)) };
  sampled.samples = [...sampled.samples.filter((s) => s.at > at - KEPT_MS), { at, ...total, usedMb: mem.usedMb, swapUsedMb: mem.swapUsedMb }];
  sampled.latest = { at, everyMs: EVERY_MS, total, machine: mem, groups, samples: sampled.samples };
}

async function sampleOnce() {
  if (sampled.isRunning) return;
  sampled.isRunning = true;
  try {
    await sample();
  } catch (error) {
    console.error("resources: sample failed", error);
  } finally {
    sampled.ownPids.clear();
    sampled.isRunning = false;
  }
}

export function keepSamplingResources() {
  void sampleOnce();
  setInterval(() => void sampleOnce(), EVERY_MS);
}

export const resources = () => sampled.latest;

export function briefResources() {
  const r = sampled.latest;
  return r ? { at: r.at, total: r.total, machine: r.machine } : null;
}
