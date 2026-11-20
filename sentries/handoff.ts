#!/usr/bin/env bun
import { yarnEnv } from "../shared/legacy-maxflow";
import { statSync } from "node:fs";
import { BASE as base } from "../instance";
import { type Fill, lastFill, percent } from "../context-fill";
import { isRecord } from "../shared/guards";
import { takeOver } from "./singleton";
import { lastLinesWithin } from "./transcript-read";

if (import.meta.main) takeOver("handoff");

const INTERVAL_MS = Number(process.env["HANDOFF_INTERVAL"] ?? 30_000);
const FULL_PCT = Number(process.env["HANDOFF_PCT"] ?? 60);
// constraint: Claude Code compacts a chat over 200k tokens once it sits ~54 min idle at its prompt, a minute before its prompt cache expires
const IDLE_COMPACT_TOKENS = Number(process.env["HANDOFF_IDLE_TOKENS"] ?? 200_000);
const IDLE_ASK_MS = Number(process.env["HANDOFF_IDLE_MIN"] ?? 40) * 60_000;
const WARM_CACHE_MS = 50 * 60_000;
const COMPLETE_AFTER_MS = 5 * 60_000;
const GIVE_UP_AFTER_MS = 30 * 60_000;
const TAIL_BYTES = 1_000_000;
const FETCH_MS = 10_000;
const isDryRun = process.env["HANDOFF_DRY"] === "1";
const HEADERS = { "x-yarn-from": yarnEnv("SESSION") ?? "" };

type Agent = { id: string; name: string; transcript: string; status: string; asleep: boolean; wait: { kind: string } | null; role: { handedTo?: string } };
const isAgent = (s: unknown): s is Agent =>
  isRecord(s) && s["running"] === true && s["agent"] === true && s["sentry"] !== true && typeof s["transcript"] === "string" && isRecord(s["role"]) && typeof s["role"]["handedTo"] !== "string";

const fills = new Map<string, { size: number; fill: Fill | undefined }>();
const asked = new Map<string, number>();

function fillOf(path: string) {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  const kept = fills.get(path);
  if (kept?.size === size) return kept.fill;
  const fill = lastFill(lastLinesWithin(path, TAIL_BYTES));
  fills.set(path, { size, fill });
  return fill;
}

function whyHandOff(a: Agent, fill: Fill) {
  if (a.status === "working") return;
  const idle = Date.now() - fill.at;
  const pct = percent(fill);
  if (pct >= FULL_PCT && (!a.asleep || idle < WARM_CACHE_MS)) return `${String(pct)}% full`;
  const isIdleCompactComing = !a.asleep && a.wait?.kind !== "done" && fill.tokens >= IDLE_COMPACT_TOKENS && idle >= IDLE_ASK_MS && idle < WARM_CACHE_MS;
  return isIdleCompactComing ? `${String(Math.round(fill.tokens / 1000))}k tokens and idle ${String(Math.round(idle / 60_000))} min` : undefined;
}

const post = async (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_MS) });

async function ask(a: Agent, fill: Fill, why: string) {
  console.log(`${new Date().toLocaleTimeString()}  ${isDryRun ? "would ask" : "asking"} ${a.name} [${a.id}] for a hand-off note: ${why} (${fill.model}, ${String(fill.tokens)} of ${String(fill.window)})`);
  if (isDryRun) return;
  const res = await post(`/api/sessions/${a.id}/handoff`, { tokens: fill.tokens, window: fill.window });
  if (res.status === 202) asked.set(a.id, Date.now());
  else console.log(`  refused: ${await res.text()}`);
}

async function completeIfTheTurnEndWasMissed(a: Agent) {
  const at = asked.get(a.id);
  if (at === undefined || a.status === "working" || Date.now() - at < COMPLETE_AFTER_MS) return;
  if (Date.now() - at > GIVE_UP_AFTER_MS) asked.delete(a.id);
  const res = await post(`/api/sessions/${a.id}/handoff`, { complete: true });
  if (!res.ok) return;
  console.log(`${new Date().toLocaleTimeString()}  handed ${a.name} [${a.id}] off after its turn end went unseen`);
  asked.delete(a.id);
}

async function tick() {
  const listed: unknown = await (await fetch(`${base}/api/sessions`, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_MS) })).json();
  const agents = Array.isArray(listed) ? listed.filter(isAgent) : [];
  for (const id of asked.keys()) if (agents.every((a) => a.id !== id)) asked.delete(id);
  for (const a of agents) {
    if (asked.has(a.id)) {
      await completeIfTheTurnEndWasMissed(a);
      continue;
    }
    const fill = fillOf(a.transcript);
    const why = fill && whyHandOff(a, fill);
    if (fill && why !== undefined) await ask(a, fill, why);
  }
}

console.log(`handoff sentry: every ${String(INTERVAL_MS / 1000)}s, asks agents at ${String(FULL_PCT)}% context, or over ${String(IDLE_COMPACT_TOKENS / 1000)}k and idle ${String(IDLE_ASK_MS / 60_000)} min, to hand off to a fresh agent${isDryRun ? " (dry run)" : ""}`);
for (;;) {
  try {
    await tick();
  } catch (error) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, error);
  }
  await Bun.sleep(INTERVAL_MS);
}
