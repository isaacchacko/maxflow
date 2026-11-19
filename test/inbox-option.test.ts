import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An inbox a server from before the inbox files left in the tmux option @mf-inbox is read once: the next server writes it to the
// file and unsets the option, so a restart after the inbox empties (and its file goes) doesn't deliver the old value again.
// Booted like boot.test.ts, twice on one tmux socket; the session is a shell, so nothing is delivered to it.
const instance = `ci-${crypto.randomUUID().slice(0, 6)}`;
const port = 20000 + Math.floor(Math.random() * 20000);
const home = mkdtempSync(join(tmpdir(), "maxflow-inbox-"));
const base = `http://localhost:${port}`;
const socket = `maxflow-v2-${instance}`;
const { INVOCATION_ID, ...env } = process.env;
let server: ReturnType<typeof Bun.spawn> | undefined;

async function boot() {
  server = Bun.spawn(["bun", join(import.meta.dir, "../server.ts"), `--maxflow-dev=${instance}`], {
    env: { ...env, HOME: home, MAXFLOW_INSTANCE: instance, MAXFLOW_PORT: String(port), MAXFLOW_SENTRIES: "0", MAXFLOW_SESSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const end = Date.now() + 20_000; !(await fetch(`${base}/api/sessions`).then((r) => r.ok, () => false)); await Bun.sleep(200)) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}`);
    if (Date.now() > end) throw new Error("server didn't answer in 20s");
  }
}
async function stop() {
  server?.kill();
  await server?.exited;
}

afterAll(async () => {
  await stop();
  const socketPath = Bun.spawnSync(["tmux", "-L", socket, "display-message", "-p", "#{socket_path}"]).stdout.toString().trim();
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"]);
  if (socketPath) rmSync(socketPath, { force: true });
  rmSync(home, { recursive: true, force: true });
});

test("an inbox left in the tmux option moves to the file once", async () => {
  await boot();
  const res = await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({ name: "inbox-test", cmd: ["sh", "-c", "sleep 60"], cwd: home }) });
  const { id } = (await res.json()) as { id: string };
  await stop();
  const option = (...args: string[]) => Bun.spawnSync(["tmux", "-L", socket, ...args]).stdout.toString().trim();
  option("set-option", "-t", `mf-${id}`, "@mf-inbox", JSON.stringify(["[maxflow] old"]));
  await boot();
  const file = join(home, `.maxflow-v2-${instance}`, "inboxes", `${id}.json`);
  expect(JSON.parse(readFileSync(file, "utf8")).inbox).toEqual(["[maxflow] old"]);
  expect(option("show-options", "-v", "-t", `mf-${id}`, "@mf-inbox")).toBe("");
  // Emptied, the file goes, and the next server finds nothing to deliver.
  await stop();
  rmSync(file);
  await boot();
  expect(existsSync(file)).toBe(false);
}, 60_000);
