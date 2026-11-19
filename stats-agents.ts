import { DIR } from "./instance";
import { namesTable } from "./state";
import { busLog, isResolution, noteResolution, statsThreads, type BusEvent, type StatsThread } from "./stats-sources";
import type { SessionInfo } from "./stats-health";
import { dayKey, lastDays, midnight } from "./stats-week";
import { ACTIVE_GAP_MS, cost, loadUsage, type FileUsage, type Tokens, type Usage } from "./usage";

const USAGE_STALE_MS = 120_000;

const usageScan: { process: Bun.Subprocess | undefined } = { process: undefined };
const usageMemo: { last: Usage | undefined } = { last: undefined };

function isScanningAfterFreshening(at: number) {
  if (usageScan.process?.exitCode === null) return true;
  if (Date.now() - at < USAGE_STALE_MS) return false;
  usageScan.process = Bun.spawn(["bun", `${DIR}/usage.ts`], { cwd: DIR, stdout: "ignore", stderr: "inherit" });
  return true;
}

type Identity = { key: string; id: string; name: string; kind: "agent" | "sentry" | "outside"; objective: string | undefined; role: string | undefined };
type Group = Omit<Identity, "key"> & {
  dollars: number;
  saved: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  messages: number;
  activeMs: number;
  first?: number;
  last?: number;
  models: Record<string, number>;
  prs: number;
  threads: number;
};
type Who = { live: Map<string, SessionInfo>; named: Record<string, string> };
type ModelSpend = { model: string; t: Tokens; dollars: number; saved: number };
type ModelTotals = { dollars: number; tokens: number };

const tokenTotal = (t: Tokens) => t[0] + t[1] + t[2] + t[3] + t[4];

function routingOf(s: SessionInfo | undefined, f: FileUsage, parent: FileUsage | undefined) {
  return { objective: s?.role?.objective ?? f.objective ?? parent?.objective, role: s?.role?.role ?? f.role ?? parent?.role };
}

function nameOf(yarnId: string, who: Who, f: FileUsage, parent: FileUsage | undefined) {
  return who.live.get(yarnId)?.name ?? who.named[yarnId] ?? f.name ?? parent?.name ?? yarnId;
}

const cwdOf = (path: string, f: FileUsage, parent: FileUsage | undefined) => f.cwd ?? parent?.cwd ?? path.split("/").slice(-2, -1)[0] ?? "";

function identityOf(path: string, f: FileUsage, files: Record<string, FileUsage>, who: Who): Identity {
  const parent = f.parent === undefined ? undefined : files[f.parent];
  const yarnId = f.yarn ?? parent?.yarn;
  const cwd = cwdOf(path, f, parent);
  if (yarnId === undefined) return { key: `outside:${cwd}`, id: cwd, name: cwd.replace(process.env.HOME ?? "", "~"), kind: "outside", ...routingOf(undefined, f, parent) };
  const s = who.live.get(yarnId);
  const name = nameOf(yarnId, who, f, parent);
  return { key: yarnId, id: yarnId, name, kind: s?.sentry === true || name.startsWith("sentry:") ? "sentry" : "agent", ...routingOf(s, f, parent) };
}

const newGroup = ({ id, name, kind, objective, role }: Identity): Group => ({
  id,
  name,
  kind,
  objective,
  role,
  dollars: 0,
  saved: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  messages: 0,
  activeMs: 0,
  models: {},
  prs: 0,
  threads: 0,
});

function withModelSpend(g: Group, { model, t, dollars, saved }: ModelSpend): Group {
  return {
    ...g,
    dollars: g.dollars + dollars,
    saved: g.saved + saved,
    tokens: { input: g.tokens.input + t[0], output: g.tokens.output + t[1], cacheRead: g.tokens.cacheRead + t[4], cacheWrite: g.tokens.cacheWrite + (t[2] + t[3]) },
    messages: g.messages + t[5],
    models: { ...g.models, [model]: (g.models[model] ?? 0) + dollars },
  };
}

function withDaySpend(g: Group, activeMs: number, spends: ModelSpend[]): Group {
  let next = { ...g, activeMs: g.activeMs + activeMs };
  for (const spend of spends) next = withModelSpend(next, spend);
  return next;
}

function withDailyModels(perModel: Record<string, [number, number]>, spends: ModelSpend[]) {
  const next = { ...perModel };
  for (const { model, t, dollars } of spends) {
    const [dayDollars, dayTokens] = next[model] ?? [0, 0];
    next[model] = [dayDollars + dollars, dayTokens + tokenTotal(t)];
  }
  return next;
}

function withSpan(g: Group, f: FileUsage & { first: number }): Group {
  const last = f.last ?? Number.NaN;
  return { ...g, first: Math.min(g.first ?? f.first, f.first), last: Math.max(g.last ?? last, last) };
}

type Spend = { groups: Map<string, Group>; daily: Map<string, Record<string, [number, number]>>; byModel: Map<string, ModelTotals> };

function addFileSpend(spend: Spend, f: FileUsage, identity: Identity, inWindow: Set<string>) {
  for (const [day, d] of Object.entries(f.days)) {
    if (!inWindow.has(day)) continue;
    const spends = Object.entries(d.models).map(([model, t]) => ({ model, t, ...cost(model, t) }));
    spend.groups.set(identity.key, withDaySpend(spend.groups.get(identity.key) ?? newGroup(identity), d.activeMs, spends));
    spend.daily.set(day, withDailyModels(spend.daily.get(day) ?? {}, spends));
    for (const { model, t, dollars } of spends) {
      const totals = spend.byModel.get(model) ?? { dollars: 0, tokens: 0 };
      spend.byModel.set(model, { dollars: totals.dollars + dollars, tokens: totals.tokens + tokenTotal(t) });
    }
  }
  const g = spend.groups.get(identity.key);
  const { first } = f;
  if (g && first !== undefined) spend.groups.set(identity.key, withSpan(g, { ...f, first }));
}

function spendInWindow(usage: Usage, inWindow: Set<string>, who: Who): Spend {
  const spend: Spend = { groups: new Map(), daily: new Map(), byModel: new Map() };
  for (const [path, f] of Object.entries(usage.files)) addFileSpend(spend, f, identityOf(path, f, usage.files, who), inWindow);
  return spend;
}

const toldOf = (e: BusEvent) => {
  const told = e.data["told"];
  return Array.isArray(told) ? told.filter((id): id is string => typeof id === "string") : [];
};

function outcomesSince(events: BusEvent[], from: number) {
  const merged = new Map<string, string[]>();
  const resolvedAt = new Map<string, number>();
  for (const e of events) {
    if (e.at < from) continue;
    const pr = String(e.data["pr"]);
    if (e.topic.startsWith("gh/") && e.topic.endsWith("/merged") && !merged.has(pr)) merged.set(pr, toldOf(e));
    else if (isResolution(e)) noteResolution(resolvedAt, e);
  }
  return { merged, resolvedAt };
}

type Outcomes = ReturnType<typeof outcomesSince>;

function creditOutcomes(groups: Map<string, Group>, { merged, resolvedAt }: Outcomes, threads: StatsThread[]) {
  const credit = (id: string, field: "prs" | "threads") => {
    const g = groups.get(id);
    if (g) groups.set(id, { ...g, [field]: g[field] + 1 });
  };
  for (const told of merged.values()) for (const id of told) credit(id, "prs");
  for (const t of threads) if (resolvedAt.has(t.id)) for (const id of t.routers ?? []) credit(id, "threads");
}

type ObjectiveRollup = { id: string; title: string; dollars: number; agents: number; activeMs: number; prs: Set<string>; threads: number };

function objectiveRollups(all: Group[], titles: Map<string, string>, groups: Map<string, Group>, outcomes: Outcomes, threads: StatsThread[]) {
  const byObjective = new Map<string, ObjectiveRollup>();
  for (const g of all) {
    if (g.objective === undefined || g.objective === "") continue;
    const o = byObjective.get(g.objective) ?? { id: g.objective, title: titles.get(g.objective) ?? g.objective, dollars: 0, agents: 0, activeMs: 0, prs: new Set<string>(), threads: 0 };
    byObjective.set(g.objective, { ...o, dollars: o.dollars + g.dollars, agents: o.agents + 1, activeMs: o.activeMs + g.activeMs });
  }
  for (const [pr, told] of outcomes.merged)
    for (const id of told) {
      const o = groups.get(id)?.objective;
      if (o !== undefined && o !== "") byObjective.get(o)?.prs.add(pr);
    }
  for (const t of threads) {
    const o = t.objective === undefined ? undefined : byObjective.get(t.objective);
    if (o && outcomes.resolvedAt.has(t.id)) byObjective.set(o.id, { ...o, threads: o.threads + 1 });
  }
  return [...byObjective.values()].map((o) => ({ ...o, prs: o.prs.size })).toSorted((a, b) => b.dollars - a.dollars);
}

function totalsOf(all: Group[], outcomes: Outcomes) {
  const sum = (f: (g: Group) => number) => all.reduce((n, g) => n + f(g), 0);
  return {
    dollars: sum((g) => g.dollars),
    saved: sum((g) => g.saved),
    input: sum((g) => g.tokens.input),
    output: sum((g) => g.tokens.output),
    cacheRead: sum((g) => g.tokens.cacheRead),
    cacheWrite: sum((g) => g.tokens.cacheWrite),
    messages: sum((g) => g.messages),
    activeMs: sum((g) => g.activeMs),
    agents: all.filter((g) => g.kind === "agent").length,
    yarnDollars: sum((g) => (g.kind === "outside" ? 0 : g.dollars)),
    prs: outcomes.merged.size,
    threads: outcomes.resolvedAt.size,
  };
}

function memoizedUsage() {
  const raw = loadUsage();
  const { last } = usageMemo;
  if (last?.at === raw.at) return last;
  usageMemo.last = raw;
  return raw;
}

export function agents(windowDays: number, sessions: SessionInfo[], objectives: { id: string; title: string }[]) {
  const usage = memoizedUsage();
  const scanning = isScanningAfterFreshening(usage.at);
  const days = lastDays(windowDays);
  const who: Who = { live: new Map(sessions.map((s) => [s.id, s])), named: namesTable.all() };
  const { groups, daily, byModel } = spendInWindow(usage, new Set(days), who);
  const outcomes = outcomesSince(busLog().events, midnight(days[0] ?? dayKey(Date.now())));
  const threads = statsThreads();
  creditOutcomes(groups, outcomes, threads);
  const all = [...groups.values()];
  return {
    at: usage.at,
    scanning,
    days,
    activeGapMin: ACTIVE_GAP_MS / 60_000,
    totals: totalsOf(all, outcomes),
    daily: days.map((d) => ({ day: d, models: daily.get(d) ?? {} })),
    models: [...byModel].map(([model, v]) => ({ model, ...v })).toSorted((a, b) => b.dollars - a.dollars),
    groups: all.toSorted((a, b) => b.dollars - a.dollars),
    objectives: objectiveRollups(all, new Map(objectives.map((o) => [o.id, o.title])), groups, outcomes, threads),
  };
}
