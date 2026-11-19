import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boots server.ts as a throwaway instance: its own port, tmux socket and HOME (so its state dir), no sentries, and at most
// one session, which runs a shell sleep, never claude. It is stopped by its own pid and socket, never by pattern.
const instance = `ci-${crypto.randomUUID().slice(0, 6)}`;
const port = 20000 + Math.floor(Math.random() * 20000);
const home = mkdtempSync(join(tmpdir(), "maxflow-boot-"));
const base = `http://localhost:${port}`;
const socket = `maxflow-v2-${instance}`;
// A CI runner is a systemd service, and INVOCATION_ID would have server.ts start panes through systemd-run --user,
// which needs a user session the runner doesn't have.
const { INVOCATION_ID, ...env } = process.env;
const server = Bun.spawn(["bun", join(import.meta.dir, "../server.ts"), `--maxflow-dev=${instance}`], {
  env: { ...env, HOME: home, MAXFLOW_INSTANCE: instance, MAXFLOW_PORT: String(port), MAXFLOW_SENTRIES: "0", MAXFLOW_SESSION: "" },
  stdout: "pipe",
  stderr: "pipe",
});

afterAll(async () => {
  server.kill();
  await server.exited;
  // kill-server leaves the socket file behind.
  const socketPath = Bun.spawnSync(["tmux", "-L", socket, "display-message", "-p", "#{socket_path}"]).stdout.toString().trim();
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"]);
  if (socketPath) rmSync(socketPath, { force: true });
  rmSync(home, { recursive: true, force: true });
});

async function up() {
  for (const end = Date.now() + 20_000; Date.now() < end; await Bun.sleep(200)) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}: ${await new Response(server.stderr).text()}`);
    if (await fetch(`${base}/api/sessions`).then((r) => r.ok, () => false)) return;
  }
  throw new Error("server didn't answer in 20s");
}

test("a fresh instance boots and answers", async () => {
  await up();
  expect(await (await fetch(`${base}/api/sessions`)).json()).toEqual([]);
  const world = await fetch(`${base}/api/world`);
  expect(world.status).toBe(200);
  expect(await world.json()).toBeObject();
  expect((await fetch(`${base}/`)).status).toBe(200);
}, 30_000);

test("it starts a session in tmux and lists it", async () => {
  const res = await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({ name: "boot-test", cmd: ["sh", "-c", "sleep 30"], cwd: home }) });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  const listed = (await (await fetch(`${base}/api/sessions`)).json()) as { id: string; name: string }[];
  expect(listed.map((s) => [s.id, s.name])).toEqual([[id, "boot-test"]]);
  expect(Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", `mf-${id}`]).exitCode).toBe(0);
}, 30_000);
