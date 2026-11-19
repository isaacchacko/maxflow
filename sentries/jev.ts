#!/usr/bin/env bun
import { BASE } from "../instance";
import { candidatesAt, funnelPick, jevConfig, routeObjective, type JevConfig, type ObjectiveRow } from "../jev";
import { appendStateText, objectivesTable, readStateJson, writeStateJson } from "../state";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("jev");

const STATE_FILE = "jev-state.json";
const LOG_FILE = "jev-shadow.jsonl";
const WAIT_MS = 60_000;
const HEADERS_SO_THE_GRAPH_DRAWS_THIS_SENTRY = { "x-maxflow-from": process.env["MAXFLOW_SESSION"] ?? "" };

type BusEvent = { seq: number; at: number; topic: string; data: Record<string, unknown> };

function isBusEvent(value: unknown): value is BusEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e["seq"] === "number" && typeof e["at"] === "number" && typeof e["topic"] === "string" && typeof e["data"] === "object" && e["data"] !== null;
}

async function events(topic: string, after: number | "now", wait = 0) {
  const res = await fetch(`${BASE}/api/events?topic=${topic}&after=${String(after)}&wait=${String(wait)}`, { headers: HEADERS_SO_THE_GRAPH_DRAWS_THIS_SENTRY, signal: AbortSignal.timeout(wait + 15_000) });
  const body: unknown = await res.json();
  return { list: Array.isArray(body) ? body.filter(isBusEvent) : [], seq: Number(res.headers.get("x-maxflow-seq") ?? 0) };
}

async function signalOf(route: BusEvent, config: JevConfig) {
  const signalSeq = Number(route.data["seq"]);
  const signal = (await events("signal/**", signalSeq - 1)).list.find((e) => e.seq === signalSeq);
  const source = signal?.data["source"];
  const text = signal?.data["text"];
  if (signal === undefined || typeof text !== "string" || typeof source !== "string" || !config.sources.has(source)) return undefined;
  return { signalSeq, at: signal.at, source, text };
}

async function shadow(route: BusEvent) {
  const config = jevConfig();
  const objective = route.data["objective"];
  if (config === undefined || typeof objective !== "string" || objective === "") return;
  const signal = await signalOf(route, config);
  if (signal === undefined) return;
  const { signalSeq, source, text } = signal;
  const objectives = new Map((objectivesTable.read() as ObjectiveRow[]).map((o) => [o.id, o]));
  const candidates = candidatesAt(objectives, signal.at, (o) => o.closed !== true);
  const funnel = funnelPick(objectives, objective, signal.at);
  const base = { seq: signalSeq, at: signal.at, source, funnel, routedTo: route.data["routedTo"], candidates: candidates.length, model: config.model };
  try {
    const jev = await routeObjective(config, text, candidates);
    const top = Object.entries(jev.probabilities).sort(([, a], [, b]) => b - a).slice(0, 3);
    appendStateText(LOG_FILE, `${JSON.stringify({ ...base, jev: jev.choice, confidence: jev.confidence, agrees: jev.choice === funnel, top, ms: jev.ms })}\n`);
    console.log(`${String(signalSeq)} funnel=${funnel} jev=${jev.choice} (${jev.confidence.toFixed(2)}, ${String(jev.ms)}ms)`);
  } catch (error) {
    appendStateText(LOG_FILE, `${JSON.stringify({ ...base, error: String(error) })}\n`);
    console.error(`${String(signalSeq)} jev failed: ${String(error)}`);
  }
}

const isState = (value: unknown): value is { seq: number } => typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["seq"] === "number";

if (import.meta.main) {
  let seq = readStateJson(STATE_FILE, isState)?.seq ?? (await events("signal-route/*", "now")).seq;
  for (;;) {
    try {
      const { list } = await events("signal-route/*", seq, WAIT_MS);
      for (const route of list) {
        await shadow(route);
        seq = route.seq;
        writeStateJson(STATE_FILE, { seq });
      }
    } catch (error) {
      console.error(`reading the event bus failed: ${String(error)}`);
      await Bun.sleep(10_000);
    }
  }
}
