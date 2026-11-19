import { BASE } from "./instance";
import { readStateText, writeStateText } from "./state";

const REFRESH_EVERY_MS = 10 * 60_000;
const KILL_AFTER_MS = 90_000;
const ALERT_TIMEOUT_MS = 5000;
const REFRESHED_AT_ACROSS_PROCESSES = "mcp-refreshed";

export type McpResult = { ok: boolean; out: string; err: string };

const argv = (server: string, tool: string, args: Record<string, unknown>) => ["mcp", "--json", "--timeout", "60", "call", server, tool, JSON.stringify(args)];
const isUnknownServer = (r: McpResult) => !r.ok && (r.err + r.out).includes("unknown server");

const wasRegistryRefreshedRecently = () => Date.now() - Date.parse(readStateText(REFRESHED_AT_ACROSS_PROCESSES) ?? "") < REFRESH_EVERY_MS;

function didRefreshRegistry() {
  if (wasRegistryRefreshedRecently()) return false;
  writeStateText(REFRESHED_AT_ACROSS_PROCESSES, new Date().toISOString());
  Bun.spawnSync(["mcp", "--refresh", "servers"], { stdout: "ignore", stderr: "ignore" });
  return true;
}

async function publishStillUnknown(server: string, tool: string, problem: string) {
  try {
    await fetch(`${BASE}/api/events`, {
      method: "POST",
      body: JSON.stringify({ topic: `health/mcp/${server}`, data: { server, tool, error: problem } }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`mcp: couldn't publish health/mcp/${server}:`, error);
  }
}

function alert(server: string, tool: string, r: McpResult) {
  const error = (r.err || r.out).trim().slice(0, 300);
  console.error(`mcp: ${server} still unknown after a registry refresh: ${error}`);
  void publishStillUnknown(server, tool, error);
}

async function once(cmd: string[]): Promise<McpResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(9), KILL_AFTER_MS);
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  clearTimeout(timer);
  return { ok: (await proc.exited) === 0, out, err };
}

function onceSync(cmd: string[]): McpResult {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: KILL_AFTER_MS });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}

export async function mcp(server: string, tool: string, args: Record<string, unknown>) {
  const r = await once(argv(server, tool, args));
  if (!isUnknownServer(r) || !didRefreshRegistry()) return r;
  const retry = await once(argv(server, tool, args));
  if (isUnknownServer(retry)) alert(server, tool, retry);
  return retry;
}

export function mcpSync(server: string, tool: string, args: Record<string, unknown>) {
  const r = onceSync(argv(server, tool, args));
  if (!isUnknownServer(r) || !didRefreshRegistry()) return r;
  const retry = onceSync(argv(server, tool, args));
  if (isUnknownServer(retry)) alert(server, tool, retry);
  return retry;
}
