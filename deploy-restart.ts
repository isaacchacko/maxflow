// A deploy's restart is not a panic: `cli.ts deploy` notes here when its restart begins (from the fast-forward on, since a
// new source file already restarts the server) and how long its last restarts took, and the health sentry reads that to show
// "deploying" instead of starting a helper, until the restart runs late. It needs no database, so the sentry can read it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./instance";

const LOCK = join(STATE_DIR, "deploy.lock");
const RESTART = join(STATE_DIR, "deploy-restart.json");
// With no restart measured yet; a usual one takes 10-20s (the server adopts every tmux session before it answers).
const FIRST_EXPECTED_MS = 30_000;
const KEPT = 5;

type Restart = { pid: number; at: number; commit: string; tookMs: number[] };

const read = (): Restart | undefined => {
  try {
    return JSON.parse(readFileSync(RESTART, "utf8")) as Restart;
  } catch {
    return undefined;
  }
};

export const isDeploying = (pid: number) => {
  const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  return r.stdout.toString().includes("cli.ts deploy");
};

export function noteRestartBegins(commit: string) {
  writeFileSync(RESTART, JSON.stringify({ pid: process.pid, at: Date.now(), commit, tookMs: read()?.tookMs ?? [] }));
}

let hasAnswered = false;
export function noteRestartAnswered() {
  const restart = read();
  if (hasAnswered || restart?.pid !== process.pid) return;
  hasAnswered = true;
  writeFileSync(RESTART, JSON.stringify({ ...restart, tookMs: [...restart.tookMs, Date.now() - restart.at].slice(-KEPT) }));
}

// The restart under way, when the deploy lock is held by a live `cli.ts deploy` that has begun restarting. Expected is the
// slowest of its last few restarts, so a slow but normal one isn't taken for a panic.
export function deployRestart(): { pid: number; at: number; commit: string; expectedMs: number } | undefined {
  let holder = 0;
  try {
    holder = Number(readFileSync(LOCK, "utf8"));
  } catch {
    return undefined;
  }
  const restart = read();
  if (!holder || restart?.pid !== holder || !isDeploying(holder)) return undefined;
  return { pid: holder, at: restart.at, commit: restart.commit, expectedMs: restart.tookMs.length ? Math.max(...restart.tookMs) : FIRST_EXPECTED_MS };
}
