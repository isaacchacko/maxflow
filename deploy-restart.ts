import { deployLock, readStateJson, writeStateJson } from "./state";

const RESTART_FILE = "deploy-restart.json";
const EXPECTED_MS_BEFORE_ANY_MEASURED = 30_000;
const RESTARTS_KEPT = 5;

type Restart = { pid: number; at: number; commit: string; tookMs: number[]; hasAnswered?: boolean };
type DeployRestart = { pid: number; at: number; commit: string; expectedMs: number };

const isRestart = (value: unknown): value is Restart =>
  typeof value === "object" && value !== null && "pid" in value && "at" in value && "tookMs" in value && Array.isArray(value.tookMs);
const readRestart = () => readStateJson(RESTART_FILE, isRestart);

export const isDeploying = (pid: number) => Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString().includes("cli.ts deploy");

export function noteRestartBegins(commit: string) {
  writeStateJson(RESTART_FILE, { pid: process.pid, at: Date.now(), commit, tookMs: readRestart()?.tookMs ?? [] });
}

export function noteRestartAnswered() {
  const restart = readRestart();
  if (restart?.pid !== process.pid || restart.hasAnswered === true) return;
  writeStateJson(RESTART_FILE, { ...restart, hasAnswered: true, tookMs: [...restart.tookMs, Date.now() - restart.at].slice(-RESTARTS_KEPT) });
}

const expectedMsOf = (tookMs: number[]) => (tookMs.length > 0 ? Math.max(...tookMs) : EXPECTED_MS_BEFORE_ANY_MEASURED);

export function deployRestartUnderway(): DeployRestart | undefined {
  const holder = deployLock.holder();
  const restart = readRestart();
  if (holder === 0 || restart?.pid !== holder || !isDeploying(holder)) return undefined;
  return { pid: holder, at: restart.at, commit: restart.commit, expectedMs: expectedMsOf(restart.tookMs) };
}
