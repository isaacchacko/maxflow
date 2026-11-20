import { yarnEnv, seqOf } from "../shared/legacy-maxflow";
import { BASE as base } from "../instance";
import { lowBudgets, RATE_LOW, readRateHistory } from "../gh";
import { isRecord } from "../shared/guards";
import { run, stamp } from "./health-agent";
import type { StateAlert } from "./health-tasks";

type McpAlert = { server: string; error: string };
type BusEvent = { seq: number; data: unknown };

const FENCE = "```";
const BUDGET_SAMPLE_FRESH_MS = 5 * 60_000;
const seqSeenByTopic = new Map<string, number>();
const githubWarned = new Set<string>();

const isBusEvents = (value: unknown): value is BusEvent[] => Array.isArray(value) && value.every((e) => isRecord(e) && typeof e["seq"] === "number");
const isMcpAlert = (value: unknown): value is McpAlert => isRecord(value) && typeof value["server"] === "string" && typeof value["error"] === "string";
const isStateAlert = (value: unknown): value is StateAlert =>
  isRecord(value) && typeof value["name"] === "string" && typeof value["problem"] === "string" && typeof value["kept"] === "string" && typeof value["isGating"] === "boolean";

async function eventsSinceLastCheckSkippingTheBacklogAtFirst(topic: string): Promise<unknown[]> {
  const seen = seqSeenByTopic.get(topic);
  const res = await fetch(`${base}/api/events?topic=${topic}&after=${String(seen ?? "now")}`, { signal: AbortSignal.timeout(5000) });
  const body: unknown = await res.json();
  if (!isBusEvents(body)) throw new TypeError(`/api/events didn't return a list of events for ${topic}`);
  seqSeenByTopic.set(topic, body.at(-1)?.seq ?? Number(seqOf(res)));
  return seen === undefined ? [] : body.map((e) => e.data);
}

export const mcpAlerts = async () => (await eventsSinceLastCheckSkippingTheBacklogAtFirst("health/mcp/**")).filter(isMcpAlert);
export const stateAlerts = async () => (await eventsSinceLastCheckSkippingTheBacklogAtFirst("health/state/**")).filter(isStateAlert);

function ghCallers() {
  return run(["ps", "-Ao", "etime=,args="])
    .out.split("\n")
    .filter((l) => /(^|\/|\s)gh\s+(run|api|pr)\b/.test(l))
    .map((l) => l.trim().slice(0, 160))
    .slice(0, 10);
}

const pt = (at: number) => new Date(at).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });

async function postBudgetWarning(title: string, text: string) {
  try {
    await fetch(`${base}/api/threads`, { method: "POST", headers: { "x-yarn-from": yarnEnv("SESSION") ?? "" }, body: JSON.stringify({ title, text }), signal: AbortSignal.timeout(10_000) });
    console.log(`${stamp()}  warned: ${title}`);
  } catch (error) {
    console.error(`${stamp()}  couldn't post the GitHub budget warning:`, error);
  }
}

export async function warnGithubBudget() {
  const last = readRateHistory().at(-1);
  if (last === undefined || Date.now() - last.at > BUDGET_SAMPLE_FRESH_MS) return;
  for (const key of lowBudgets(last)) {
    const b = last[key];
    const id = `${key}@${String(b.reset)}`;
    if (githubWarned.has(id)) continue;
    githubWarned.add(id);
    const name = key === "core" ? "REST" : "GraphQL";
    const callers = ghCallers();
    const text = [
      `GitHub's ${name} budget for Isaac's account is down to ${String(b.remaining)} of ${String(b.limit)} (under ${String(RATE_LOW * 100)}%), and it resets at ${pt(b.reset)} PT. Every agent, sentry and his own Dryft work share it, and at zero every gh call fails until the reset.`,
      callers.length > 0 ? `gh calls running now:\n${FENCE}\n${callers.join("\n")}\n${FENCE}` : "No gh process is running now.",
      `Spend over the last two hours: Stats → Performance, "GitHub API left".`,
    ].join("\n\n");
    await postBudgetWarning(`GitHub ${name} budget at ${String(Math.round((b.remaining / b.limit) * 100))}%`, text);
  }
}
