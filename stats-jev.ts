import { NEW_OBJECTIVE, settledLabel, type ObjectiveRow, type ThreadRow } from "./jev";
import { objectivesTable, readStateText, threadsTable } from "./state";
import { DAY_MS, dayKey, lastDays } from "./stats-week";

const LOG_FILE = "jev-shadow.jsonl";
const DOLLARS_PER_INPUT_MTOK = 0.042;
const CONFIDENT = 0.8;
const RECENT_DISAGREEMENTS = 12;

type Call = {
  seq: number;
  at: number;
  called?: number;
  question?: string;
  funnel: string;
  jev?: string;
  thread?: string | undefined;
  confidence?: number;
  ms?: number;
  status?: number | "timeout" | "network";
  error?: string;
  tokens?: { input: number; output: number };
  tokensEstimated?: boolean;
  model?: string;
  prompt?: string;
};

function isCall(value: unknown): value is Call {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c["seq"] === "number" && typeof c["at"] === "number" && typeof c["funnel"] === "string";
}

function calls(): Call[] {
  return (readStateText(LOG_FILE) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(isCall);
}

function quantile(values: number[], q: number) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0 ? undefined : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const calledAt = (c: Call) => c.called ?? c.at;
const isAnswered = (c: Call) => c.error === undefined && c.jev !== undefined;
const isLimited = (c: Call) => c.status === 429;
const isError = (c: Call) => c.error !== undefined && !isLimited(c);
const sumOf = (list: Call[], pick: (c: Call) => number) => list.reduce((n, c) => n + pick(c), 0);

function usage(list: Call[], days: string[]) {
  const input = sumOf(list, (c) => c.tokens?.input ?? 0);
  const ms = list.filter(isAnswered).map((c) => c.ms).filter((m) => m !== undefined);
  return {
    daily: days.map((day) => {
      const on = list.filter((c) => dayKey(calledAt(c)) === day);
      return { day, calls: on.length, errors: on.filter(isError).length, limited: on.filter(isLimited).length };
    }),
    totals: {
      calls: list.length,
      answered: list.filter(isAnswered).length,
      errors: list.filter(isError).length,
      limited: list.filter(isLimited).length,
      timeouts: list.filter((c) => c.status === "timeout").length,
      input,
      output: sumOf(list, (c) => c.tokens?.output ?? 0),
      tokensEstimated: list.some((c) => c.tokensEstimated === true),
      dollars: (input / 1e6) * DOLLARS_PER_INPUT_MTOK,
      p50: quantile(ms, 0.5),
      p90: quantile(ms, 0.9),
    },
  };
}

function quality(list: Call[]) {
  const objectives = new Map((objectivesTable.read() as ObjectiveRow[]).map((o) => [o.id, o]));
  const threads = new Map((threadsTable.read() as ThreadRow[]).map((t) => [t.id, t]));
  const titleOf = (id: string) => ({ id, title: id === NEW_OBJECTIVE ? "new objective" : (objectives.get(id)?.title ?? id) });
  const scored = list.map((c) => {
    const signal = { seq: c.seq, at: c.at, text: c.thread === undefined ? "" : `as thread ${c.thread}` };
    const settled = settledLabel(signal, c.funnel, objectives, threads);
    return { ...c, label: settled.label, thread: c.thread ?? settled.thread };
  });
  const confident = scored.filter((c) => (c.confidence ?? 0) >= CONFIDENT);
  const disagreements = scored
    .filter((c) => c.jev !== c.label)
    .toSorted((a, b) => calledAt(b) - calledAt(a))
    .slice(0, RECENT_DISAGREEMENTS)
    .map((c) => {
      const thread = c.thread === undefined ? undefined : threads.get(c.thread);
      return {
        seq: c.seq,
        at: calledAt(c),
        thread: thread === undefined ? undefined : { id: thread.id, title: (thread as ThreadRow & { title?: string }).title ?? thread.id },
        jev: titleOf(c.jev ?? NEW_OBJECTIVE),
        settled: titleOf(c.label),
        funnel: titleOf(c.funnel),
        confidence: c.confidence ?? 0,
      };
    });
  return {
    quality: {
      scored: scored.length,
      agrees: scored.filter((c) => c.jev === c.label).length,
      funnelAgrees: scored.filter((c) => c.funnel === c.label).length,
      corrected: scored.filter((c) => c.funnel !== c.label).length,
      confident: confident.length,
      confidentRight: confident.filter((c) => c.jev === c.label).length,
    },
    disagreements,
  };
}

export function jev(dayCount: number) {
  const days = lastDays(dayCount);
  const all = calls();
  const since = Date.now() - dayCount * DAY_MS;
  const inRange = all.filter((c) => calledAt(c) >= since);
  const prompt = all.findLast((c) => (c.question ?? "objective") === "objective" && c.prompt !== undefined)?.prompt;
  const routed = inRange.filter((c) => (c.question ?? "objective") === "objective" && isAnswered(c) && c.prompt === prompt);
  const first = all[0];
  return {
    at: Date.now(),
    days,
    since: first === undefined ? undefined : calledAt(first),
    model: all.at(-1)?.model,
    prompt,
    pricePerInputMtok: DOLLARS_PER_INPUT_MTOK,
    confidentAt: CONFIDENT,
    ...usage(inRange, days),
    ...quality(routed),
  };
}
