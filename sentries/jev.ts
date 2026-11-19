#!/usr/bin/env bun
import { BASE } from "../instance";
import { candidatesAt, JevCallError, jevConfig, ROUTE_PROMPT, routeObjective, settledLabel, SIZE_PROMPT, sizeRequest, type Choice, type JevConfig, type ObjectiveRow, type ThreadRow } from "../jev";
import { appendStateText, objectivesTable, readStateJson, threadsTable, writeStateJson } from "../state";
import { takeOver } from "./singleton";

if (import.meta.main) takeOver("jev");

const STATE_FILE = "jev-state.json";
const LOG_FILE = "jev-shadow.jsonl";
const WAIT_MS = 60_000;
const SHADOWED = "signal-*/*";
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

async function signalOf(event: BusEvent, config: JevConfig) {
  const signalSeq = Number(event.data["seq"]);
  const signal = (await events("signal/**", signalSeq - 1)).list.find((e) => e.seq === signalSeq);
  const source = signal?.data["source"];
  const text = signal?.data["text"];
  if (signal === undefined || typeof text !== "string" || typeof source !== "string" || !config.sources.has(source)) return;
  return { signalSeq, at: signal.at, source, text };
}

function failure(error: unknown) {
  if (error instanceof JevCallError) return { error: error.message, status: error.status, ms: error.ms };
  return { error: String(error) };
}

type Asked = { question: "objective" | "size"; funnel: string; prompt: string; extra: Record<string, unknown>; ask: () => Promise<Choice> };

async function record(signal: NonNullable<Awaited<ReturnType<typeof signalOf>>>, config: JevConfig, asked: Asked) {
  const called = Date.now();
  const base = { question: asked.question, seq: signal.signalSeq, at: signal.at, called, source: signal.source, funnel: asked.funnel, ...asked.extra, model: config.model, prompt: asked.prompt };
  try {
    const jev = await asked.ask();
    const top = Object.entries(jev.probabilities).toSorted(([, a], [, b]) => b - a).slice(0, 3);
    const tokens = { input: jev.usage.input, output: jev.usage.output };
    appendStateText(LOG_FILE, `${JSON.stringify({ ...base, jev: jev.choice, confidence: jev.confidence, agrees: jev.choice === asked.funnel, top, ms: jev.ms, status: 200, tokens, ...(jev.usage.estimated === true && { tokensEstimated: true }) })}\n`);
    console.log(`${String(signal.signalSeq)} ${asked.question} funnel=${asked.funnel} jev=${jev.choice} (${jev.confidence.toFixed(2)}, ${String(jev.ms)}ms)`);
  } catch (error) {
    appendStateText(LOG_FILE, `${JSON.stringify({ ...base, ...failure(error) })}\n`);
    console.error(`${String(signal.signalSeq)} ${asked.question} jev failed: ${failure(error).error}`);
  }
}

function objectiveQuestion(route: BusEvent, signal: { signalSeq: number; at: number; text: string }, config: JevConfig): Asked | undefined {
  const objective = route.data["objective"];
  if (typeof objective !== "string" || objective === "") return;
  const objectives = new Map((objectivesTable.read() as ObjectiveRow[]).map((o) => [o.id, o]));
  const threads = new Map((threadsTable.read() as ThreadRow[]).map((t) => [t.id, t]));
  const candidates = candidatesAt(objectives, signal.at, (o) => o.closed !== true);
  const { funnel, thread } = settledLabel({ seq: signal.signalSeq, at: signal.at, text: signal.text }, objective, objectives, threads);
  const extra = { thread, routedTo: route.data["routedTo"], candidates: candidates.length };
  return { question: "objective", funnel, prompt: ROUTE_PROMPT, extra, ask: async () => await routeObjective(config, signal.text, candidates) };
}

function sizeQuestion(event: BusEvent, signal: { text: string }, config: JevConfig): Asked | undefined {
  const size = event.data["size"];
  if (typeof size !== "string" || event.data["by"] !== "funnel") return;
  const extra = { thread: event.data["thread"], session: event.data["session"] };
  return { question: "size", funnel: size, prompt: SIZE_PROMPT, extra, ask: async () => await sizeRequest(config, signal.text) };
}

async function shadow(event: BusEvent) {
  const config = jevConfig();
  if (config === undefined) return;
  const signal = await signalOf(event, config);
  if (signal === undefined) return;
  const asked = event.topic.startsWith("signal-size/") ? sizeQuestion(event, signal, config) : objectiveQuestion(event, signal, config);
  if (asked !== undefined) await record(signal, config, asked);
}

async function drain(after: number) {
  let seq = after;
  const { list } = await events(SHADOWED, seq, WAIT_MS);
  for (const event of list) {
    await shadow(event);
    seq = event.seq;
    writeStateJson(STATE_FILE, { seq });
  }
  return seq;
}

const isState = (value: unknown): value is { seq: number } => typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["seq"] === "number";

if (import.meta.main) {
  let seq = readStateJson(STATE_FILE, isState)?.seq;
  for (;;) {
    try {
      seq ??= (await events(SHADOWED, "now")).seq;
      seq = await drain(seq);
    } catch (error) {
      console.error(`reading the event bus failed: ${String(error)}`);
      await Bun.sleep(10_000);
    }
  }
}
