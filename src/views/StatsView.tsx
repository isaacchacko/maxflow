import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { liveStore } from "@/store";
import { cn } from "@/lib/utils";

// yarn's statistics a week at a time, opened from the mark at the top of the sidebar: his GitHub week beside how fast yarn moved,
// each number with the change from the week before. The server counts them (stats.ts); GitHub's are cached there, not fetched per look.

type RepoCounts = { commits: number; opened: number; merged: number; closed: number; reviews: number; requested: number; added: number; deleted: number };
type GhWeek = { at: number; final: boolean; repos: Record<string, RepoCounts>; error?: string };
type Latency = { id: string; samples: { at: number; ms: number }[] };
type Count = { id: string; days: number[] };
type YarnWeek = { since: number; latencies: Latency[]; counts: Count[] };
type Stats = { week: { key: string; from: number; to: number; days: string[] }; gh: { now: GhWeek; before: GhWeek }; yarn: YarnWeek; yarnBefore: YarnWeek };

const GH: { key: keyof RepoCounts; label: string }[] = [
  { key: "commits", label: "Commits" },
  { key: "opened", label: "PRs opened" },
  { key: "merged", label: "PRs merged" },
  { key: "closed", label: "PRs closed unmerged" },
  { key: "reviews", label: "Reviews given" },
  { key: "requested", label: "Reviews asked of you" },
];
const LATENCY: Record<string, { label: string; hint: string }> = {
  route: { label: "Time to route", hint: "Your message to the funnel routing it" },
  slack: { label: "Slack to yarn", hint: "A Slack message sent to yarn reporting it" },
  reply: { label: "Time to reply", hint: "Your thread message to an agent's first reply" },
  ask: { label: "Answer to action", hint: "Your answer to an agent's ask to its next message" },
};
const COUNT: Record<string, string> = {
  said: "Messages from you",
  started: "Agents started",
  opened: "Threads opened",
  resolved: "Threads resolved",
  prsOpened: "PRs opened by agents",
  prsMerged: "PRs merged",
};

// Weeks are cut in his time zone on the server, so days are keyed the same way here.
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const short = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "narrow", timeZone: "UTC" });

function quantile(values: number[], q: number) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}
const median = (values: number[]) => quantile(values, 0.5);

function duration(ms: number | undefined) {
  if (ms === undefined) return "–";
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(s < 36_000 ? 1 : 0)}h`;
}

/** The change from last week as a signed percent; green when it went the good way. A total for a week still running can't be
 * compared to a whole one yet, so it shows last week's total instead. */
function Delta({ now, before, lowerIsBetter, running, terse }: { now?: number; before?: number; lowerIsBetter?: boolean; running?: boolean; terse?: boolean }) {
  if (running && before !== undefined) return <span className="text-xs text-muted-foreground tabular-nums">{terse ? `vs ${before.toLocaleString()}` : `${before.toLocaleString()} last week`}</span>;
  if (now === undefined || !before) return <span className="text-xs text-muted-foreground">–</span>;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <span className="text-xs text-muted-foreground tabular-nums">same</span>;
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return <span className={cn("text-xs tabular-nums", good ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>{pct > 0 ? `+${pct}` : pct}%</span>;
}

/** Seven small bars, one per day, Monday first; a day with no value is left as an empty slot. */
function Bars({ values, days, format }: { values: (number | undefined)[]; days: string[]; format: (v: number) => string }) {
  const max = Math.max(1, ...values.map(v => v ?? 0));
  return (
    <div className="mt-3 flex h-12 items-end gap-1">
      {values.map((v, i) => (
        <div key={days[i]} className="flex h-full flex-1 flex-col items-center justify-end gap-0.5" title={`${short(days[i]!)}: ${v === undefined ? "none" : format(v)}`}>
          <div className="w-full rounded-sm bg-primary/70" style={{ height: v ? `${Math.max(4, (v / max) * 100)}%` : 0 }} />
          <span className="text-[10px] leading-none text-muted-foreground">{weekday(days[i]!)}</span>
        </div>
      ))}
    </div>
  );
}

function Card({ label, hint, value, delta, children }: { label: string; hint?: string; value: string; delta: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3.5" title={hint}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {delta}
      </div>
      {children}
    </div>
  );
}

function GitHub({ stats }: { stats: Stats }) {
  const { now, before } = stats.gh;
  const running = stats.week.to > Date.now();
  const repos = Object.keys(now.repos).length ? Object.keys(now.repos) : Object.keys(before.repos);
  const sum = (w: GhWeek, key: keyof RepoCounts) => (Object.keys(w.repos).length ? Object.values(w.repos).reduce((n, r) => n + r[key], 0) : undefined);
  const lines = (w: GhWeek) => {
    const a = sum(w, "added"), d = sum(w, "deleted");
    return a === undefined ? undefined : a + d!;
  };
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-base font-semibold">GitHub</h2>
        <span className="text-xs text-muted-foreground">
          {repos.join(", ")} · checked {new Date(now.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          {now.error && <span className="text-rose-600 dark:text-rose-400"> · last fetch failed, showing older numbers</span>}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {GH.map(({ key, label }) => (
          <Card key={key} label={label} value={String(sum(now, key) ?? "–")} delta={<Delta now={sum(now, key)} before={sum(before, key)} running={running} />}>
            <PerRepo repos={repos} now={now} before={before} value={r => r[key]} running={running} />
          </Card>
        ))}
        <Card
          label="Lines changed in merged PRs"
          value={lines(now) === undefined ? "–" : lines(now)!.toLocaleString()}
          delta={<Delta now={lines(now)} before={lines(before)} running={running} />}
        >
          <div className="mt-1 text-xs tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{(sum(now, "added") ?? 0).toLocaleString()}</span>{" "}
            <span className="text-rose-600 dark:text-rose-400">−{(sum(now, "deleted") ?? 0).toLocaleString()}</span>
          </div>
          <PerRepo repos={repos} now={now} before={before} value={r => r.added + r.deleted} running={running} />
        </Card>
      </div>
    </section>
  );
}

function PerRepo({ repos, now, before, value, running }: { repos: string[]; now: GhWeek; before: GhWeek; value: (r: RepoCounts) => number; running: boolean }) {
  if (repos.length < 2) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5">
      {repos.map(name => {
        const n = now.repos[name], b = before.repos[name];
        return (
          <li key={name} className="flex items-baseline gap-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{name.split("/")[1]}</span>
            <span className="tabular-nums">{n ? value(n).toLocaleString() : "–"}</span>
            <Delta now={n && value(n)} before={b && value(b)} running={running} terse />
          </li>
        );
      })}
    </ul>
  );
}

function Yarn({ stats }: { stats: Stats }) {
  const { yarn, yarnBefore, week } = stats;
  const beforeLog = week.to <= yarn.since;
  const partial = !beforeLog && week.from < yarn.since;
  const dayIndex = (at: number) => week.days.indexOf(DAY_KEY.format(at));
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-base font-semibold">yarn</h2>
        <span className="text-xs text-muted-foreground">
          {beforeLog
            ? "No yarn log reaches back to this week"
            : partial
              ? `Log starts ${new Date(yarn.since).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, so this week is partial`
              : "Medians, with each day's median below"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {yarn.latencies.map(l => {
          const ms = l.samples.map(s => s.ms);
          const prev = yarnBefore.latencies.find(p => p.id === l.id)?.samples.map(s => s.ms) ?? [];
          const byDay = week.days.map((_, i) => median(l.samples.filter(s => dayIndex(s.at) === i).map(s => s.ms)));
          const meta = LATENCY[l.id] ?? { label: l.id, hint: "" };
          return (
            <Card key={l.id} label={meta.label} hint={meta.hint} value={duration(median(ms))} delta={<Delta now={median(ms)} before={median(prev)} lowerIsBetter />}>
              <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                p90 {duration(quantile(ms, 0.9))} · {ms.length} times
              </div>
              <Bars values={byDay} days={week.days} format={duration} />
            </Card>
          );
        })}
        {yarn.counts.map(c => {
          const total = c.days.reduce((a, b) => a + b, 0);
          const prev = yarnBefore.counts.find(p => p.id === c.id)?.days.reduce((a, b) => a + b, 0);
          return (
            <Card key={c.id} label={COUNT[c.id] ?? c.id} value={total.toLocaleString()} delta={<Delta now={total} before={yarn.since > week.from - 7 * 86_400_000 ? undefined : prev} running={week.to > Date.now()} />}>
              <Bars values={c.days} days={week.days} format={String} />
            </Card>
          );
        })}
      </div>
    </section>
  );
}

export function StatsView() {
  const [weekKey, setWeekKey] = useState<string>();
  const [stats, setStats] = useState<Stats>();
  const [failed, setFailed] = useState<string>();
  const live = liveStore.use();

  useEffect(() => {
    if (!live) return;
    let gone = false;
    setFailed(undefined);
    fetch(`/api/stats${weekKey ? `?week=${weekKey}` : ""}`)
      .then(async r => (r.ok ? r.json() : Promise.reject(new Error(await r.text()))))
      .then(s => !gone && setStats(s))
      .catch((e: Error) => !gone && setFailed(e.message));
    return () => void (gone = true);
  }, [weekKey, live]);

  const shown = stats && (!weekKey || stats.week.key === weekKey) ? stats : undefined;
  const key = shown?.week.key ?? weekKey;
  const thisWeek = !weekKey || (!!shown && shown.week.to > Date.now());
  const step = (n: number) => key && setWeekKey(addDays(key, 7 * n));

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
        <h1 className="text-sm font-medium">Stats</h1>
        <div className="ml-auto flex items-center gap-1">
          {!thisWeek && (
            <button onClick={() => setWeekKey(undefined)} className="mr-1 text-xs text-muted-foreground hover:text-foreground">
              This week
            </button>
          )}
          <button onClick={() => step(-1)} disabled={!key} title="Week before" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-36 text-center text-sm tabular-nums">{key ? `${short(key)} – ${short(addDays(key, 6))}` : "This week"}</span>
          <button onClick={() => step(1)} disabled={!key || thisWeek} title="Week after" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
            <ChevronRight className="size-4" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex max-w-5xl flex-col gap-8 px-5 py-5", !shown && stats && "opacity-50")}>
          {failed ? (
            <p className="text-sm text-rose-600 dark:text-rose-400">Couldn't load stats: {failed}</p>
          ) : !stats ? (
            <p className="text-sm text-muted-foreground">Counting…</p>
          ) : (
            <>
              <GitHub stats={shown ?? stats} />
              <Yarn stats={shown ?? stats} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
