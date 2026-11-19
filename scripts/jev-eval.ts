#!/usr/bin/env bun
import { candidatesAt, jevConfig, NEW_OBJECTIVE, objectiveCriteria, ROUTE_INSTRUCTIONS, ROUTE_PROMPT, routeObjective, settledLabel, type ObjectiveRow, type ThreadRow } from "../jev";
import { appendStateText, objectivesTable, readStateText, threadsTable } from "../state";

const ANSWERS_FILE = "jev-eval-answers.jsonl";
const DOLLARS_PER_MTOK = 0.042;
const THRESHOLDS = [0, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95];

type Event = { seq: number; at: number; topic: string; data: Record<string, unknown> };
type Example = { seq: number; at: number; source: string; text: string; funnel: string; label: string; labelFrom: "thread" | "route"; candidates: ObjectiveRow[] };
type Answer = { seq: number; model: string; prompt?: string; choice: string; confidence: number };

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const shouldRun = args.includes("--run");
const config = jevConfig();
const sources = new Set((flag("--sources") ?? [...(config?.sources ?? ["isaac"])].join(",")).split(","));

const events: Event[] = (readStateText("events.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event);
const signals = new Map(events.filter((e) => e.topic.startsWith("signal/")).map((e) => [e.seq, e]));
const routes = events.filter((e) => e.topic.startsWith("signal-route/"));
const objectives = new Map((objectivesTable.read() as ObjectiveRow[]).map((o) => [o.id, o]));
const threads = new Map((threadsTable.read() as ThreadRow[]).map((t) => [t.id, t]));

const lastActivity = new Map<string, number>();
for (const t of threads.values()) {
  const messages = t.messages ?? [];
  if (t.objective !== undefined) for (const m of messages) lastActivity.set(t.objective, Math.max(lastActivity.get(t.objective) ?? 0, m.at));
}

function example(route: Event): Example | undefined {
  const signal = signals.get(Number(route.data["seq"]));
  const text = signal?.data["text"];
  const source = signal?.data["source"];
  if (signal === undefined || typeof text !== "string" || typeof source !== "string" || !sources.has(source)) return;
  const { funnel, label, from } = settledLabel({ seq: signal.seq, at: signal.at, text }, String(route.data["objective"]), objectives, threads);
  const candidates = candidatesAt(objectives, signal.at, (o) => o.closed !== true || (lastActivity.get(o.id) ?? 0) >= signal.at);
  return { seq: signal.seq, at: signal.at, source, text, funnel, label, labelFrom: from, candidates };
}

const examples = routes.map(example).filter((e) => e !== undefined);
const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);
const count = (isCounted: (e: Example) => boolean) => examples.filter(isCounted).length;

console.log(`${String(examples.length)} routed signals from ${[...sources].join(", ")} (of ${String(routes.length)} routes)`);
console.log(`  labels from the signal's thread: ${String(count((e) => e.labelFrom === "thread"))}; from the route alone: ${String(count((e) => e.labelFrom === "route"))}`);
console.log(`  label "new": ${pct(count((e) => e.label === NEW_OBJECTIVE), examples.length)}; open objectives per signal: median ${String(examples.map((e) => e.candidates.length).toSorted((a, b) => a - b)[Math.floor(examples.length / 2)] ?? 0)}`);
console.log(`  funnel agrees with the settled label: ${pct(count((e) => e.funnel === e.label), examples.length)} (moves and merges corrected the rest)`);

const sentChars = examples.reduce((sum, e) => sum + e.text.length + ROUTE_INSTRUCTIONS.length + JSON.stringify(objectiveCriteria(e.candidates)).length, 0);
console.log(`  a run sends about ${String(Math.round(sentChars / 4 / 1000))}k tokens, about $${((sentChars / 4 / 1e6) * DOLLARS_PER_MTOK).toFixed(3)} on hosted Jev`);

if (args.includes("--show")) for (const e of examples) console.log(JSON.stringify({ seq: e.seq, source: e.source, funnel: e.funnel, label: e.label, text: e.text.slice(0, 200) }));

const answers = new Map(
  (readStateText(ANSWERS_FILE) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Answer)
    .filter((a) => a.model === config?.model && (a.prompt ?? "") === (flag("--prompt") ?? ROUTE_PROMPT))
    .map((a) => [a.seq, a]),
);

if (shouldRun) {
  if (config === undefined) throw new Error("no Jev configured: set JEV_URL (and JEV_API_KEY for hosted) in ~/.maxflow-v2/jev.env");
  const unsent = [...sources].filter((source) => !config.sources.has(source));
  if (unsent.length > 0) throw new Error(`JEV_SOURCES does not clear ${unsent.join(", ")} for sending; only ${[...config.sources].join(", ")} may leave the machine`);
  for (const e of examples) {
    if (answers.has(e.seq)) continue;
    const jev = await routeObjective(config, e.text, e.candidates);
    const answer = { seq: e.seq, model: config.model, prompt: ROUTE_PROMPT, choice: jev.choice, confidence: jev.confidence };
    answers.set(e.seq, answer);
    appendStateText(ANSWERS_FILE, `${JSON.stringify(answer)}\n`);
  }
}

const scored = examples.map((e) => ({ e, a: answers.get(e.seq) })).filter((pair): pair is { e: Example; a: Answer } => pair.a !== undefined);
if (scored.length > 0) {
  console.log(`\nJev (${config?.model ?? "?"}, prompt ${flag("--prompt") ?? ROUTE_PROMPT}) on ${String(scored.length)} signals: agrees with the label ${pct(scored.filter(({ e, a }) => a.choice === e.label).length, scored.length)}, with the funnel ${pct(scored.filter(({ e, a }) => a.choice === e.funnel).length, scored.length)}`);
  console.log("confidence >=  share decided  accuracy there  funnel accuracy there");
  for (const t of THRESHOLDS) {
    const kept = scored.filter(({ a }) => a.confidence >= t);
    console.log(`${t.toFixed(2).padStart(13)}  ${pct(kept.length, scored.length).padStart(13)}  ${pct(kept.filter(({ e, a }) => a.choice === e.label).length, kept.length).padStart(15)}  ${pct(kept.filter(({ e }) => e.funnel === e.label).length, kept.length).padStart(21)}`);
  }
}
