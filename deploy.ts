import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { isDeploying, noteRestartAnswered, noteRestartBegins } from "./deploy-restart";
import { fetchCommitCi, isFailed, repoOf } from "./gh";
import { BASE, IS_LIVE } from "./instance";
import { LOG, checkout, restartCommand } from "./service";
import { isRecord } from "./shared/guards";
import { deployLock, readStateJson, writeStateText } from "./state";

const API_TIMEOUT_MS = 5000;
const SENTRY_RESTART_TIMEOUT_MS = 60_000;
const RESTART_SETTLE_MS = 120_000;
const SENTRY_COMMITS = "sentry-commits.json";

const run = (cmd: string[], cwd?: string) => {
  const r = Bun.spawnSync(cmd, cwd === undefined ? { stdout: "pipe", stderr: "pipe" } : { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trimEnd(), err: r.stderr.toString().trimEnd() };
};
const fail = (why: string): never => {
  console.error(`deploy: ${why}`);
  return process.exit(1);
};

type Session = { id: string; name: string; running: boolean; createdAt: number };
const isSession = (value: unknown): value is Session =>
  isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && typeof value["running"] === "boolean" && typeof value["createdAt"] === "number";

async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
async function sessions(): Promise<Session[] | undefined> {
  const list = await fetchJson(`${BASE}/api/sessions`);
  return Array.isArray(list) ? list.filter(isSession) : undefined;
}
const sentries = (list: Session[]) => list.filter((s) => s.name.startsWith("sentry:") && s.running).map((s) => s.name);

const CI_WAIT_MS = 15 * 60_000;
async function awaitGreenCi(live: string, commit: string) {
  const short = commit.slice(0, 7);
  const repo = repoOf(live);
  const deadline = Date.now() + CI_WAIT_MS;
  while (Date.now() < deadline) {
    const ci = fetchCommitCi(repo, [commit]).get(commit);
    if (ci?.state === "SUCCESS") return;
    if (ci !== undefined && isFailed(ci.state)) fail(`CI is ${ci.state.toLowerCase()} on ${short}${ci.failed.length > 0 ? ` (${ci.failed.join(", ")})` : ""}, so live stays where it is: gh run list --commit ${commit}`);
    await Bun.sleep(10_000);
  }
  fail(`CI hasn't passed on ${short} after ${CI_WAIT_MS / 60_000} minutes, so live stays where it is`);
}

const transpiler = new Bun.Transpiler({ loader: "ts" });
function importClosure(dir: string, file: string, seen = new Set<string>()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  if (!file.endsWith(".ts")) return seen;
  const imports = transpiler.scanImports(readFileSync(join(dir, file), "utf8").replace(/^#!.*/, ""));
  for (const { path } of imports) {
    if (!path.startsWith(".")) continue;
    const base = normalize(join(dirname(file), path));
    const hit = [base, `${base}.ts`, join(base, "index.ts")].find((f) => existsSync(join(dir, f)) && statSync(join(dir, f)).isFile());
    if (hit !== undefined) importClosure(dir, hit, seen);
  }
  return seen;
}

function headAt(dir: string, ms: number) {
  const entries = run(["git", "log", "-g", "--date=unix", "--format=%H %gd", "HEAD"], dir)
    .out.split("\n")
    .map((line) => line.split(" ", 2));
  return entries.find(([, ref = ""]) => Number(/\{(\d+)\}/.exec(ref)?.[1]) * 1000 <= ms)?.[0];
}

type RanOn = Record<string, { id: string; commit: string }>;
const isRanOn = (value: unknown): value is RanOn =>
  isRecord(value) && Object.values(value).every((entry) => isRecord(entry) && typeof entry["id"] === "string" && typeof entry["commit"] === "string");
const ranOn = (): RanOn => readStateJson(SENTRY_COMMITS, isRanOn) ?? {};

type Stale = { name: string; fresh: boolean };

function staleness(s: Session, dir: string, from: string | undefined, changedSince: (from: string) => Set<string>): Stale | undefined {
  if (from === undefined || from === "") return { name: s.name, fresh: true };
  const sentry = s.name.slice(7);
  const brief = `sentries/${sentry}.md`;
  const own = [`sentries/${sentry}.ts`, brief].filter((f) => existsSync(join(dir, f)));
  const isChanged = own.some((f) =>
    importClosure(dir, f)
      .values()
      .some((dep) => changedSince(from).has(dep)),
  );
  return isChanged ? { name: s.name, fresh: changedSince(from).has(brief) } : undefined;
}

export function staleSentries(dir: string, to: string, list: Session[]) {
  const diffs = new Map<string, Set<string>>();
  const changedSince = (from: string) => {
    const known = diffs.get(from);
    if (known) return known;
    const changed = new Set(run(["git", "diff", "--name-only", from, to], dir).out.split("\n"));
    diffs.set(from, changed);
    return changed;
  };
  const record = ranOn();
  const commitRunBy = (s: Session) => {
    const kept = record[s.name];
    return kept?.id === s.id ? kept.commit : headAt(dir, s.createdAt);
  };
  return list
    .filter((s) => s.name.startsWith("sentry:") && s.running)
    .map((s) => staleness(s, dir, commitRunBy(s), changedSince))
    .filter((stale) => stale !== undefined);
}

function restartNote(name: string, reply: { resumed?: string; fresh?: boolean }, isBriefChanged: boolean) {
  if (reply.resumed !== undefined && reply.resumed !== "") return `${name} (resumed its chat)`;
  if (reply.fresh === true) return `${name} (fresh chat${isBriefChanged ? ", brief changed" : ""})`;
  return name;
}

export async function restartSentries(stale: Stale[], list: Session[], commit: string) {
  const record = ranOn();
  const done: string[] = [];
  for (const { name, fresh } of stale) {
    const res = await fetch(`${BASE}/api/sentries/restart`, { method: "POST", body: JSON.stringify({ name, fresh }), signal: AbortSignal.timeout(SENTRY_RESTART_TIMEOUT_MS) });
    if (!res.ok) fail(`restarting ${name} failed: ${res.status} ${await res.text()}`);
    const reply = (await res.json()) as { resumed?: string; fresh?: boolean };
    const id = list.find((s) => s.name === name)?.id ?? fail(`${name} isn't in the session list`);
    record[name] = { id, commit };
    done.push(restartNote(name, reply, fresh));
  }
  writeStateText(SENTRY_COMMITS, JSON.stringify(record, null, 2));
  console.log(`restarted ${done.join(", ")}, whose code changed`);
}

const LOCK_WAIT_MS = 30 * 60_000;
async function takeDeployLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const announced = new Set<number>();
  for (let holder = deployLock.claim(); holder !== 0; holder = deployLock.claim()) {
    if (!isDeploying(holder)) deployLock.dropIfHeldBy(holder);
    else if (Date.now() > deadline) fail(`the deploy in pid ${holder} has held the deploy lock for ${LOCK_WAIT_MS / 60_000} minutes`);
    else {
      if (!announced.has(holder)) console.log(`waiting for the deploy already running (pid ${holder}) to finish`);
      announced.add(holder);
      await Bun.sleep(2000);
    }
  }
  process.on("exit", () => deployLock.dropIfHeldBy(process.pid));
}

function fastForwardTarget(live: string) {
  const dirty = run(["git", "status", "--porcelain"], live).out;
  if (dirty) fail(`${live} has uncommitted changes, and a restart would ship them:\n${dirty}\nWhoever owns them commits them from their own worktree and pushes; nobody edits the live checkout.`);
  const branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], live).out;
  if (!run(["git", "fetch", "origin", branch], live).ok) fail(`couldn't fetch origin/${branch}`);
  const from = run(["git", "rev-parse", "HEAD"], live).out;
  const to = run(["git", "rev-parse", "FETCH_HEAD"], live).out;
  if (!run(["git", "merge-base", "--is-ancestor", from, to], live).ok)
    fail(`live has commits origin/${branch} doesn't:\n${run(["git", "log", "--oneline", `${to}..${from}`], live).out}\nPush them to origin/${branch} first.`);
  if (from === to) {
    console.log(`live is already at origin/${branch} (${to.slice(0, 7)}); nothing to deploy`);
    return null;
  }
  return { from, to };
}

async function currentSeq() {
  try {
    const res = await fetch(`${BASE}/api/events?after=now`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    return Number(res.headers.get("x-maxflow-seq") ?? 0);
  } catch {
    return 0;
  }
}

function shipAndRestart(live: string, { from, to }: { from: string; to: string }) {
  noteRestartBegins(to);
  if (!run(["git", "merge", "--ff-only", to], live).ok) fail(`couldn't fast-forward ${live} to ${to.slice(0, 7)}`);
  if (!run(["bun", "install", "--frozen-lockfile"], live).ok) fail(`bun install --frozen-lockfile failed in ${live}, which is now at ${to.slice(0, 7)} but not restarted`);
  const shipped = run(["git", "log", "--oneline", "--no-decorate", `${from}..${to}`], live)
    .out.split("\n")
    .map((l) => `  ${l.slice(0, 120)}`)
    .join("\n");
  console.log(`live ${from.slice(0, 7)} -> ${to.slice(0, 7)}:\n${shipped}`);
  if (!run(["sh", "-c", restartCommand]).ok) fail(`${restartCommand} failed`);
}

const hasSettled = (before: Session[] | undefined, list: Session[] | undefined) =>
  list !== undefined && (before === undefined || sentries(before).every((n) => sentries(list).includes(n)));

async function sessionsAfterRestart(before: Session[] | undefined) {
  const deadline = Date.now() + RESTART_SETTLE_MS;
  let after: Session[] | undefined;
  while (Date.now() < deadline) {
    after = await sessions();
    if (hasSettled(before, after)) break;
    if (after) noteRestartAnswered();
    await Bun.sleep(2000);
  }
  const answered = after ?? fail(`the server isn't answering ${BASE} after 2 minutes; see ${LOG}. The health sentry started a recovery agent once the restart ran 10s past its usual time.`);
  noteRestartAnswered();
  return answered;
}

async function killedSince(seq: number) {
  if (seq === 0 || Number.isNaN(seq)) return new Set<string>();
  const res = await fetch(`${BASE}/api/events?topic=session/*/killed&after=${seq}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  return new Set(((await res.json()) as { data: { session: string } }[]).map((e) => e.data.session));
}

function failOnLoss(before: Session[] | undefined, after: Session[], killed: Set<string>) {
  const lost = before?.filter((s) => s.running && after.every((a) => a.id !== s.id) && !killed.has(s.id)) ?? [];
  const missing = before ? sentries(before).filter((n) => !sentries(after).includes(n)) : [];
  console.log(`${after.length} sessions (${before ? `${before.length} before` : "the server was down before"}), ${sentries(after).length} sentries running`);
  const problems = [
    lost.length > 0 ? `these sessions are gone: ${lost.map((s) => `${s.id} ${s.name}`).join(", ")}` : "",
    missing.length > 0 ? `these sentries aren't running: ${missing.join(", ")}` : "",
  ].filter((problem) => problem !== "");
  if (problems.length > 0) fail(`after the restart ${problems.join("; ")}. See ${LOG}.`);
}

export async function deploy() {
  if (!IS_LIVE) fail("a dev instance runs from its own checkout; deploy ships the live yarn");
  const live = checkout() ?? fail("no service is installed; run cli.ts install from the live checkout");
  await takeDeployLock();
  const target = fastForwardTarget(live);
  if (target === null) return;
  await awaitGreenCi(live, target.to);
  const before = await sessions();
  const seq = await currentSeq();
  shipAndRestart(live, target);
  const after = await sessionsAfterRestart(before);
  failOnLoss(before, after, await killedSince(seq));
  const stale = staleSentries(live, target.to, after);
  if (stale.length > 0) await restartSentries(stale, after, target.to);
}
