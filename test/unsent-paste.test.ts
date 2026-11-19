import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A server that finds one of its inbox messages pasted in a claude's prompt with no record of pasting it (what a restart between
// the paste and a landed Enter leaves) presses Enter on it. The "claude" is a fake on PATH that draws claude's input box holding
// "[Pasted text #1 +2 lines]" and writes a file when Enter reaches it. Booted like boot.test.ts, and stopped by its own pid and socket.
const instance = `ci-${crypto.randomUUID().slice(0, 6)}`;
const port = 20000 + Math.floor(Math.random() * 20000);
const home = mkdtempSync(join(tmpdir(), "maxflow-unsent-"));
const base = `http://localhost:${port}`;
const socket = `maxflow-v2-${instance}`;
const bin = join(home, "bin");
const submitted = join(home, "submitted");
mkdirSync(bin);
const rule = "─".repeat(40);
writeFileSync(
  join(bin, "claude"),
  `#!/bin/sh
stty raw -echo
printf '${rule}\\r\\n❯ [Pasted text #1 +2 lines]\\r\\n${rule}\\r\\n'
while :; do
  c=$(dd bs=1 count=1 2>/dev/null | od -An -c | tr -d ' ')
  [ "$c" = '\\r' ] && { touch '${submitted}'; printf '\\033[2J\\033[H${rule}\\r\\n❯ \\r\\n${rule}\\r\\n'; }
done
`,
);
chmodSync(join(bin, "claude"), 0o755);
const { INVOCATION_ID, ...env } = process.env;
const server = Bun.spawn(["bun", join(import.meta.dir, "../server.ts"), `--maxflow-dev=${instance}`], {
  env: { ...env, PATH: `${bin}:${env.PATH}`, HOME: home, MAXFLOW_INSTANCE: instance, MAXFLOW_PORT: String(port), MAXFLOW_SENTRIES: "0", MAXFLOW_SESSION: "" },
  stdout: "pipe",
  stderr: "pipe",
});

afterAll(async () => {
  server.kill();
  await server.exited;
  const socketPath = Bun.spawnSync(["tmux", "-L", socket, "display-message", "-p", "#{socket_path}"]).stdout.toString().trim();
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"]);
  if (socketPath) rmSync(socketPath, { force: true });
  rmSync(home, { recursive: true, force: true });
});

test("a message left pasted in the prompt unsent gets its Enter", async () => {
  for (const end = Date.now() + 20_000; !(await fetch(`${base}/api/sessions`).then((r) => r.ok, () => false)); await Bun.sleep(200)) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}: ${await new Response(server.stderr).text()}`);
    if (Date.now() > end) throw new Error("server didn't answer in 20s");
  }
  const res = await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({ name: "unsent-test", cmd: ["claude"], cwd: home }) });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect((await fetch(`${base}/api/sessions/${id}/notify`, { method: "POST", body: JSON.stringify({ text: "[maxflow] one\ntwo\nthree" }) })).status).toBe(202);
  for (const end = Date.now() + 20_000; !existsSync(submitted) && Date.now() < end; ) await Bun.sleep(250);
  expect(existsSync(submitted)).toBe(true);
  // The box emptied, which with no transcript confirms it: the message leaves the stored inbox a restart would read.
  const db = new Database(join(home, `.maxflow-v2-${instance}`, "yarn.db"), { readonly: true });
  const stored = () => db.query("SELECT data FROM inboxes WHERE key = ?").get(id);
  for (const end = Date.now() + 10_000; stored() !== null && Date.now() < end; ) await Bun.sleep(250);
  expect(stored()).toBeNull();
  db.close();
}, 45_000);
