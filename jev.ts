import { readStateText } from "./state";

export const HOSTED_JEV = "https://api.typesafe.ai";
export const NEW_OBJECTIVE = "new";
const REQUEST_TIMEOUT_MS = 30_000;
const SAME_MESSAGE_MS = 120_000;
const STATE_CHARS = 6000;

export type JevConfig = { url: string; key: string; model: string; sources: Set<string> };
export type Usage = { input: number; output: number; estimated?: true };
export type Choice = { choice: string; confidence: number; probabilities: Record<string, number>; ms: number; usage: Usage };
export type ThreadRow = { id: string; objective?: string; mergedInto?: string; signal?: number; messages?: { from: string; at: number; text: string }[] };
export type Signal = { seq: number; at: number; text: string };
export type ObjectiveRow = { id: string; title: string; at: number; closed?: boolean; mergedInto?: string; page?: { kind?: string; goal?: string }[] };

function settingsFile(): Record<string, string> {
  const lines = (readStateText("jev.env") ?? "").split("\n");
  return Object.fromEntries(lines.map((l) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter((m) => m !== null).map((m) => [m[1] ?? "", m[2] ?? ""]));
}

export function jevConfig(): JevConfig | undefined {
  const file = settingsFile();
  const setting = (name: string) => process.env[name] ?? file[name];
  const url = (setting("JEV_URL") ?? HOSTED_JEV).replace(/\/+$/, "");
  const key = setting("JEV_API_KEY") ?? setting("TYPESAFE_API_KEY") ?? "";
  if (url === HOSTED_JEV && key === "") return undefined;
  const sources = new Set((setting("JEV_SOURCES") ?? "isaac").split(",").map((s) => s.trim()).filter(Boolean));
  return { url, key, model: setting("JEV_MODEL") ?? "jev-latest", sources };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class JevCallError extends Error {
  constructor(
    message: string,
    readonly status: number | "timeout" | "network",
    readonly ms: number,
  ) {
    super(message);
  }
}

function usageOf(body: unknown, sentChars: number): Usage {
  const usage = isRecord(body) ? body["usage"] : undefined;
  if (isRecord(usage) && typeof usage["input_tokens"] === "number")
    return { input: usage["input_tokens"], output: typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0 };
  return { input: Math.round(sentChars / 4), output: 0, estimated: true };
}

async function post(config: JevConfig, body: string, started: number) {
  try {
    return await fetch(`${config.url}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.key !== "" && { authorization: `Bearer ${config.key}` }) },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new JevCallError(`jev call failed: ${String(error)}`, timedOut ? "timeout" : "network", Math.round(performance.now() - started));
  }
}

export async function decideChoice(config: JevConfig, state: string, instructions: string, criteria: Record<string, string>): Promise<Choice> {
  const started = performance.now();
  const sent = JSON.stringify({ model: config.model, state, questions: { pick: { type: "choice", instructions, criteria } } });
  const res = await post(config, sent, started);
  const ms = () => Math.round(performance.now() - started);
  const scrub = (text: string) => (config.key === "" ? text : text.replaceAll(config.key, "<key>")).slice(0, 300);
  if (!res.ok) throw new JevCallError(`jev answered ${String(res.status)}: ${scrub(await res.text())}`, res.status, ms());
  const body: unknown = await res.json();
  const answers = isRecord(body) ? body["answers"] : undefined;
  const pick = isRecord(answers) ? answers["pick"] : undefined;
  if (!isRecord(pick) || typeof pick["choice"] !== "string" || typeof pick["confidence"] !== "number" || !isRecord(pick["probabilities"]))
    throw new JevCallError(`jev's answer has no choice: ${scrub(JSON.stringify(body))}`, res.status, ms());
  return { choice: pick["choice"], confidence: pick["confidence"], probabilities: pick["probabilities"] as Record<string, number>, ms: ms(), usage: usageOf(body, sent.length) };
}

const goalOf = (o: ObjectiveRow) => o.page?.find((block) => block.kind === "vision")?.goal ?? "";

export function objectiveCriteria(candidates: ObjectiveRow[]): Record<string, string> {
  const criteria: Record<string, string> = Object.fromEntries(candidates.map((o) => [o.id, [o.title, goalOf(o)].filter(Boolean).join(": ")]));
  criteria[NEW_OBJECTIVE] = "None of these: the request starts a new piece of work that no objective above covers.";
  return criteria;
}

export const ROUTE_INSTRUCTIONS =
  "Isaac is a software engineer at Dryft, a supply-chain startup whose app (exceptions, cases, priority, Hugo, Festo and Trumpf customers) his agents work on. He also builds maxflow, also called yarn: the web app where he talks to those agents, with threads, subthreads, an inbox, a sidebar, objectives, commands, routers, sentries (slack, gh, inbox, funnel) and Chrome pages. The state is a request he sent into maxflow. Each option is an objective his agents are already working on. Which objective does this request belong to? A request about maxflow or yarn itself (its UI, threads, sidebar, agents, sentries, Slack polling) belongs to the maxflow development objective. Pick new only when the request starts work that no objective covers.";
export const ROUTE_PROMPT = Bun.hash(ROUTE_INSTRUCTIONS).toString(36);

export async function routeObjective(config: JevConfig, text: string, candidates: ObjectiveRow[]) {
  return await decideChoice(config, text.slice(0, STATE_CHARS), ROUTE_INSTRUCTIONS, objectiveCriteria(candidates));
}

export function asOf(objectives: Map<string, ObjectiveRow>, id: string, at: number): string {
  const chain: ObjectiveRow[] = [];
  for (let o = objectives.get(id); o && !chain.includes(o); o = o.mergedInto === undefined ? undefined : objectives.get(o.mergedInto)) chain.push(o);
  return chain.findLast((o) => o.at <= at)?.id ?? NEW_OBJECTIVE;
}

export function funnelPick(objectives: Map<string, ObjectiveRow>, routed: string, at: number) {
  const o = objectives.get(routed);
  return !o || o.at >= at ? NEW_OBJECTIVE : asOf(objectives, routed, at);
}

export function candidatesAt(objectives: Map<string, ObjectiveRow>, at: number, isOpen: (o: ObjectiveRow) => boolean): ObjectiveRow[] {
  const ids = new Set(objectives.values().filter((o) => o.at <= at && isOpen(o)).map((o) => asOf(objectives, o.id, at)));
  return ids.values().map((id) => objectives.get(id)).filter((o) => o !== undefined).toArray();
}

export function rootThread(threads: Map<string, ThreadRow>, id: string) {
  const seen = new Set<string>();
  let t = threads.get(id);
  while (t?.mergedInto !== undefined && !seen.has(t.id)) {
    seen.add(t.id);
    t = threads.get(t.mergedInto) ?? t;
  }
  return t;
}

export function threadOf(threads: Map<string, ThreadRow>, signal: Signal) {
  const named = /as thread (th-[0-9a-f]+)/.exec(signal.text)?.[1];
  if (named !== undefined) return threads.get(named);
  const bySignal = threads.values().find((t) => t.signal === signal.seq);
  if (bySignal !== undefined) return bySignal;
  const isTheSignal = (m: { from: string; text: string }) => m.from === "isaac" && m.text.trim() === signal.text.trim();
  const near = threads
    .values()
    .flatMap((t) => (t.messages ?? []).filter(isTheSignal).map((m) => ({ t, gap: Math.abs(m.at - signal.at) })))
    .filter((hit) => hit.gap < SAME_MESSAGE_MS)
    .toArray()
    .toSorted((a, b) => a.gap - b.gap);
  return near[0]?.t;
}

export function settledLabel(signal: Signal, routed: string, objectives: Map<string, ObjectiveRow>, threads: Map<string, ThreadRow>) {
  const funnel = funnelPick(objectives, routed, signal.at);
  const thread = threadOf(threads, signal);
  const settled = thread === undefined ? undefined : rootThread(threads, thread.id)?.objective;
  if (settled === undefined || settled === "") return { funnel, label: funnel, from: "route" as const, thread: thread?.id };
  return { funnel, label: asOf(objectives, settled, signal.at), from: "thread" as const, thread: thread?.id };
}
