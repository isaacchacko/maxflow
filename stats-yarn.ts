import { busLog, isResolution, noteResolution, statsThreads, type BusEvent, type StatsThread } from "./stats-sources";
import { dayKey, type Week } from "./stats-week";

type Sample = { at: number; ms: number };
export type Latency = { id: string; samples: Sample[] };
export type Count = { id: string; days: number[]; at: number[] };
export type YarnWeek = { since: number; latencies: Latency[]; counts: Count[] };

const YARN_FRESH_MS = 60_000;
const ALIVE_BEFORE_LOG_GRACE_MS = 10 * 60_000;

const yarnCache = new Map<string, { at: number; value: YarnWeek }>();

type LogScan = {
  signalsBySeq: Map<number, BusEvent>;
  said: number[];
  route: Sample[];
  firstSlackSighting: Map<string, number>;
  firstWait: Map<string, number>;
  resolvedAt: Map<string, number>;
  prsOpened: Map<string, number>;
  prsMerged: Map<string, number>;
};

const newLogScan = (): LogScan => ({
  signalsBySeq: new Map(),
  said: [],
  route: [],
  firstSlackSighting: new Map(),
  firstWait: new Map(),
  resolvedAt: new Map(),
  prsOpened: new Map(),
  prsMerged: new Map(),
});

const isSlackSighting = (e: BusEvent) => e.topic.startsWith("slack/") && typeof e.data["ts"] === "string" && e.topic !== "slack/notify";
const isToldPr = (e: BusEvent) => {
  const told = e.data["told"];
  return e.topic.startsWith("gh/") && Array.isArray(told) && told.length > 0;
};

function noteRoute(scan: LogScan, e: BusEvent, isInWeek: (at: number) => boolean) {
  const seq = e.data["seq"];
  const signal = typeof seq === "number" ? scan.signalsBySeq.get(seq) : undefined;
  if (signal && isInWeek(signal.at)) scan.route.push({ at: signal.at, ms: e.at - signal.at });
}

function noteSlackSighting(scan: LogScan, e: BusEvent) {
  const ts = String(e.data["ts"]);
  const previous = scan.firstSlackSighting.get(ts);
  if (previous === undefined || e.at < previous) scan.firstSlackSighting.set(ts, e.at);
}

function noteFirst(map: Map<string, number>, key: string, at: number) {
  if (!map.has(key)) map.set(key, at);
}

function scanEvent(scan: LogScan, e: BusEvent, isInWeek: (at: number) => boolean) {
  const t = e.topic;
  if (t === "signal/isaac") {
    scan.signalsBySeq.set(e.seq, e);
    if (isInWeek(e.at)) scan.said.push(e.at);
  } else if (t.startsWith("signal-route/")) noteRoute(scan, e, isInWeek);
  else if (isSlackSighting(e)) noteSlackSighting(scan, e);
  else if (t.startsWith("wait/")) noteFirst(scan.firstWait, t.slice(5), e.at);
  else if (isResolution(e)) noteResolution(scan.resolvedAt, e);
  else if (isToldPr(e)) noteFirst(t.endsWith("/merged") ? scan.prsMerged : scan.prsOpened, String(e.data["pr"]), e.at);
}

function countOf(id: string, ats: number[], w: Week): Count {
  const days = Array.from({ length: 7 }, () => 0);
  for (const at of ats) {
    const i = w.days.indexOf(dayKey(at));
    if (i !== -1) days[i] = (days[i] ?? 0) + 1;
  }
  return { id, days, at: ats };
}

function slackSamples(firstSighting: Map<string, number>, isInWeek: (at: number) => boolean) {
  const samples: Sample[] = [];
  for (const [ts, at] of firstSighting) {
    const sent = Number(ts) * 1000;
    if (isInWeek(sent) && at >= sent) samples.push({ at: sent, ms: at - sent });
  }
  return samples;
}

function threadReplySamples(t: StatsThread, isInWeek: (at: number) => boolean) {
  const samples: Sample[] = [];
  let waitingSince: number | undefined;
  for (const m of t.messages) {
    if (m.from === "isaac") waitingSince ??= m.at;
    else if (waitingSince !== undefined && m.from !== "feed") {
      if (isInWeek(waitingSince)) samples.push({ at: waitingSince, ms: m.at - waitingSince });
      waitingSince = undefined;
    }
  }
  return samples;
}

const firstReplySamples = (threads: StatsThread[], isInWeek: (at: number) => boolean) => threads.flatMap((t) => threadReplySamples(t, isInWeek));

function answeredAskSamples(events: BusEvent[], threads: StatsThread[], isInWeek: (at: number) => boolean) {
  const byThread = new Map(threads.map((t) => [t.id, t]));
  const samples: Sample[] = [];
  for (const e of events) {
    if (!e.topic.startsWith("ask/")) continue;
    const messages = byThread.get(String(e.data["thread"]))?.messages ?? [];
    const answer = messages.find((m) => m.from === "isaac" && m.at > e.at);
    const acted = answer && messages.find((m) => m.from === e.data["session"] && m.at > answer.at);
    if (answer && acted && isInWeek(answer.at)) samples.push({ at: answer.at, ms: acted.at - answer.at });
  }
  return samples;
}

function yarnWeekOf(w: Week): YarnWeek {
  const { events, since } = busLog();
  const threads = statsThreads();
  const isInWeek = (at: number) => at >= w.from && at < w.to;
  const scan = newLogScan();
  for (const e of events) scanEvent(scan, e, isInWeek);
  const thoseInWeek = (ats: MapIterator<number>) => ats.filter((at) => isInWeek(at)).toArray();
  const opened = threads.flatMap((t) => (t.messages[0] && isInWeek(t.messages[0].at) ? t.messages[0].at : []));
  return {
    since,
    latencies: [
      { id: "route", samples: scan.route },
      { id: "reply", samples: firstReplySamples(threads, isInWeek) },
      { id: "slack", samples: slackSamples(scan.firstSlackSighting, isInWeek) },
      { id: "ask", samples: answeredAskSamples(events, threads, isInWeek) },
    ],
    counts: [
      countOf("said", scan.said, w),
      countOf("started", thoseInWeek(scan.firstWait.values()).filter((at) => at > since + ALIVE_BEFORE_LOG_GRACE_MS), w),
      countOf("opened", opened, w),
      countOf("resolved", thoseInWeek(scan.resolvedAt.values()), w),
      countOf("prsOpened", thoseInWeek(scan.prsOpened.values()), w),
      countOf("prsMerged", thoseInWeek(scan.prsMerged.values()), w),
    ],
  };
}

export function yarn(w: Week): YarnWeek {
  const hit = yarnCache.get(w.key);
  if (hit && (hit.at > w.to || Date.now() - hit.at < YARN_FRESH_MS)) return hit.value;
  const value = yarnWeekOf(w);
  yarnCache.set(w.key, { at: Date.now(), value });
  return value;
}
