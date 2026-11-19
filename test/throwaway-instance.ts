import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUEST_TIMEOUT_MS = 10_000;
const BOOT_DEADLINE_MS = 20_000;

export const withTimeout = (init: RequestInit = {}): RequestInit => ({ ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

export type ThrowawayInstance = { name: string; home: string; base: string; socket: string; port: number };
type Server = { exitCode: number | null; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill: () => void };

export function throwawayInstance(homePrefix: string): ThrowawayInstance {
  const name = `ci-${crypto.randomUUID().slice(0, 6)}`;
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  return { name, port, home: mkdtempSync(join(tmpdir(), homePrefix)), base: `http://localhost:${port}`, socket: `maxflow-v2-${name}` };
}

// constraint: a CI runner is a systemd service, and INVOCATION_ID would make server.ts use systemd-run --user, which needs a user session
const { INVOCATION_ID, ...envOutsideSystemd } = process.env;

export function startServerWithoutSentries(instance: ThrowawayInstance, env: Record<string, string> = {}) {
  return Bun.spawn(["bun", join(import.meta.dir, "../server.ts"), `--maxflow-dev=${instance.name}`], {
    env: { ...envOutsideSystemd, HOME: instance.home, MAXFLOW_INSTANCE: instance.name, MAXFLOW_PORT: String(instance.port), MAXFLOW_SENTRIES: "0", MAXFLOW_SESSION: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function isAnswering(instance: ThrowawayInstance) {
  try {
    return (await fetch(`${instance.base}/api/sessions`, withTimeout())).ok;
  } catch {
    return false;
  }
}

export async function waitUntilAnswering(instance: ThrowawayInstance, server: Server) {
  for (const end = Date.now() + BOOT_DEADLINE_MS; Date.now() < end; ) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}: ${await new Response(server.stderr).text()}`);
    if (await isAnswering(instance)) return;
    await Bun.sleep(200);
  }
  throw new Error("server didn't answer in 20s");
}

function killTmuxServer(socket: string) {
  const socketPath = Bun.spawnSync(["tmux", "-L", socket, "display-message", "-p", "#{socket_path}"]).stdout.toString().trim();
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"]);
  // constraint: tmux kill-server leaves the socket file behind
  if (socketPath !== "") rmSync(socketPath, { force: true });
}

export async function stopByPidAndSocket(instance: ThrowawayInstance, server: Server) {
  server.kill();
  await server.exited;
  killTmuxServer(instance.socket);
  rmSync(instance.home, { recursive: true, force: true });
}
