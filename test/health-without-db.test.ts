import { noSessionEnv } from "../shared/legacy-maxflow";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PAGE_DEADLINE_MS = 15_000;
const instance = `nodb-${crypto.randomUUID().slice(0, 6)}`;
const port = 20_000 + Math.floor(Math.random() * 20_000);
const home = mkdtempSync(join(tmpdir(), "yarn-health-nodb-"));
mkdirSync(join(home, `.yarn-v2-${instance}`, "yarn.db"), { recursive: true });

// constraint: a CI runner is a systemd service, and INVOCATION_ID would make the sentry start tmux through systemd-run --user
const { INVOCATION_ID, ...envOutsideSystemd } = process.env;
const env = { ...envOutsideSystemd, HOME: home, YARN_INSTANCE: instance, YARN_PORT: String(port), ...noSessionEnv(), HEALTH_DEV: "1", HEALTH_PAGE_AFTER_MS: "0", HEALTH_HELPER_AFTER_MS: "3600000" };

const health = Bun.spawn(["bun", join(ROOT, "sentries/health.ts")], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });

afterAll(() => {
  health.kill();
  rmSync(home, { recursive: true, force: true });
});

async function panicState(): Promise<Response | undefined> {
  try {
    return await fetch(`http://127.0.0.1:${String(port)}/__panic/state`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return undefined;
  }
}

async function firstPanicState() {
  for (const end = Date.now() + PAGE_DEADLINE_MS; Date.now() < end; ) {
    if (health.exitCode !== null) throw new Error(`health exited ${String(health.exitCode)}: ${await new Response(health.stderr).text()}`);
    const res = await panicState();
    if (res !== undefined) return res;
    await Bun.sleep(250);
  }
  throw new Error(`no panic page on port ${String(port)} after ${String(PAGE_DEADLINE_MS)}ms`);
}

test("yarn.db can't be opened in this instance, so any table use fails", () => {
  const probe = Bun.spawnSync(["bun", "-e", 'import { namesTable } from "./state"; namesTable.all();'], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  expect(probe.exitCode).not.toBe(0);
});

test("the health sentry starts and serves the panic page without yarn.db", async () => {
  const res = await firstPanicState();
  expect(res.status).toBe(200);
  expect(res.headers.get("x-yarn-panic")).toBe("1");
  expect(await res.json()).toMatchObject({ down: true, deploy: null, agent: null, gaveUp: null });
  health.kill();
  await health.exited;
  expect(await new Response(health.stderr).text()).not.toContain("tick failed");
}, 30_000);
