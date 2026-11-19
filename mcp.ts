// Every call to the standalone `mcp` CLI (~/.local/bin/mcp). It caches the claude.ai connector registry for 12h, and a fetch that
// came back without a connector left every call to it failing with "unknown server" until the cache expired (Slack, for 6h
// on 2026-11-18). So a call that fails that way refreshes the registry, at most once per REFRESH_EVERY_MS across all sentries,
// and retries; one that still fails publishes health/mcp/<server>, which the health sentry acts on.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, STATE_DIR } from "./instance";

const REFRESH_EVERY_MS = 10 * 60_000;
const KILL_AFTER_MS = 90_000;
// Its mtime is when any process last refreshed, so sentries in separate processes share the limit.
const REFRESHED = join(STATE_DIR, "mcp-refreshed");

export type McpResult = { ok: boolean; out: string; err: string };

const argv = (server: string, tool: string, args: Record<string, unknown>) => ["mcp", "--json", "--timeout", "60", "call", server, tool, JSON.stringify(args)];
const unknownServer = (r: McpResult) => !r.ok && /unknown server/.test(r.err + r.out);

// True when this call refreshed the registry, false when another did so too recently.
function refresh() {
  if (existsSync(REFRESHED) && Date.now() - statSync(REFRESHED).mtimeMs < REFRESH_EVERY_MS) return false;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REFRESHED, new Date().toISOString());
  Bun.spawnSync(["mcp", "--refresh", "servers"], { stdout: "ignore", stderr: "ignore" });
  return true;
}

function alert(server: string, tool: string, r: McpResult) {
  const error = (r.err || r.out).trim().slice(0, 300);
  console.error(`mcp: ${server} still unknown after a registry refresh: ${error}`);
  fetch(`${BASE}/api/events`, { method: "POST", body: JSON.stringify({ topic: `health/mcp/${server}`, data: { server, tool, error } }) }).catch(() => {});
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
  if (!unknownServer(r) || !refresh()) return r;
  const retry = await once(argv(server, tool, args));
  if (unknownServer(retry)) alert(server, tool, retry);
  return retry;
}

export function mcpSync(server: string, tool: string, args: Record<string, unknown>) {
  const r = onceSync(argv(server, tool, args));
  if (!unknownServer(r) || !refresh()) return r;
  const retry = onceSync(argv(server, tool, args));
  if (unknownServer(retry)) alert(server, tool, retry);
  return retry;
}
