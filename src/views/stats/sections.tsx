
import { useState } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import { cn, hasText } from "@/lib/utils";
import { Heatmap, Stages, inJourneyOrder } from "./charts";
import { COUNT, Columns, Segmented, DAY_KEY, DAY_MS, Delta, GH, HOUR, LATENCY, Tile, duration, hourLabel, median, quantile, short, sum, useIsStillBefore, weekday, type Count, type Counts, type Latency, type Peek, type Stats } from "./parts";

export function RepoPicker({ stats, picked, onRepo }: { stats: Stats; picked?: string | undefined; onRepo: (repo: string) => void }) {
  return (
    <NativeSelect value={picked ?? stats.gh.repo} onChange={e => onRepo(e.target.value)} wrapperClassName="max-w-64" className="truncate rounded-md border bg-transparent py-0.5 pl-1.5 text-xs" title="Repo">
      {stats.gh.repos.map(r => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </NativeSelect>
  );
}

export function GhNote({ stats }: { stats: Stats }) {
  const { now, trend } = stats.gh;
  return (
    <span className="text-xs text-[var(--viz-text-2)]">
      checked {new Date(now.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      {trend.pending && " · filling in earlier weeks…"}
      {hasText(now.error) && <span className="text-rose-600 dark:text-rose-400"> · last fetch failed{now.counts ? ", showing older numbers" : ""}</span>}
    </span>
  );
}

type GhTile = { id: string; label: string; value: (c?: Counts) => number | undefined };

function GhTrendTile({ stats, tile, isWeekRunning, onWeek }: { stats: Stats; tile: GhTile; isWeekRunning: boolean; onWeek: (key: string) => void }) {
  const { now, before, trend } = stats.gh;
  const [peek, setPeek] = useState<Peek>();
  const pick = (i: number) => {
    const week = trend.weeks[i];
    if (week) onWeek(week.key);
  };
  return (
    <Tile label={tile.label} value={tile.value(now.counts)?.toLocaleString() ?? "–"} delta={<Delta now={tile.value(now.counts)} before={tile.value(before.counts)} isWeekRunning={isWeekRunning} />} peek={peek}>
      <Columns
        values={trend.weeks.map(w => tile.value(w.counts))}
        labels={trend.weeks.map(w => `Week of ${short(w.key)}`)}
        ticks={trend.weeks.map(w => short(w.key))}
        strong={i => i === trend.weeks.length - 1}
        onPeek={setPeek}
        onPick={pick}
      />
    </Tile>
  );
}

const linesChanged: GhTile = { id: "lines", label: "Lines changed in merged PRs", value: c => c && c.added + c.deleted };

export function GhTrendTiles({ stats, onWeek, keys = GH.map(g => g.key) }: { stats: Stats; onWeek: (key: string) => void; keys?: (keyof Counts)[] }) {
  const isWeekRunning = useIsStillBefore(stats.week.to);
  const tiles: GhTile[] = [...GH.filter(g => keys.includes(g.key)).map(g => ({ id: g.key, label: g.label, value: (c?: Counts) => c?.[g.key] })), linesChanged];
  return (
    <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", tiles.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
      {tiles.map(t => (
        <GhTrendTile key={t.id} stats={stats} tile={t} isWeekRunning={isWeekRunning} onWeek={onWeek} />
      ))}
    </div>
  );
}

function LatencyTile({ stats, l }: { stats: Stats; l: Latency }) {
  const { yarnBefore, week } = stats;
  const [peek, setPeek] = useState<Peek>();
  const ms = l.samples.map(s => s.ms);
  const prev = median(yarnBefore.latencies.find(p => p.id === l.id)?.samples.map(s => s.ms) ?? []);
  const byDay = week.days.map(d => median(l.samples.filter(s => DAY_KEY.format(s.at) === d).map(s => s.ms)));
  const meta = LATENCY[l.id] ?? { label: l.id, hint: "" };
  return (
    <Tile label={meta.label} hint={meta.hint} value={duration(median(ms))} delta={<Delta now={median(ms)} before={prev} isLowerBetter />} peek={peek}>
      <div className="-mt-3 text-[13px] font-medium text-[var(--viz-text-3)] tabular-nums">
        p90 {duration(quantile(ms, 0.9))} · {ms.length} times
      </div>
      <Columns values={byDay} labels={week.days.map(d => weekday(d))} strong={() => true} format={duration} onPeek={p => setPeek(p && { ...p, label: `${meta.label} · median` })} />
    </Tile>
  );
}

export function LatencyTiles({ stats }: { stats: Stats }) {
  return (
    <>
      {inJourneyOrder(stats.yarn.latencies).map(l => (
        <LatencyTile key={l.id} stats={stats} l={l} />
      ))}
    </>
  );
}

function CountTile({ stats, c, isWeekRunning }: { stats: Stats; c: Count; isWeekRunning: boolean }) {
  const { yarn, yarnBefore, week } = stats;
  const [peek, setPeek] = useState<Peek>();
  const prev = yarnBefore.counts.find(p => p.id === c.id);
  const hasWholeWeekBefore = yarn.since <= week.from - 7 * DAY_MS;
  const label = COUNT[c.id] ?? c.id;
  return (
    <Tile label={label} value={sum(c.days).toLocaleString()} delta={<Delta now={sum(c.days)} before={hasWholeWeekBefore && prev ? sum(prev.days) : undefined} isWeekRunning={isWeekRunning} />} peek={peek}>
      <Columns values={c.days} labels={week.days.map(d => weekday(d))} strong={() => true} onPeek={p => setPeek(p && { ...p, label: `${label} · ${p.label}` })} />
    </Tile>
  );
}

export function CountTiles({ stats, ids }: { stats: Stats; ids?: string[] }) {
  const isWeekRunning = useIsStillBefore(stats.week.to);
  return (
    <>
      {stats.yarn.counts
        .filter(c => !ids || ids.includes(c.id))
        .map(c => (
          <CountTile key={c.id} stats={stats} c={c} isWeekRunning={isWeekRunning} />
        ))}
    </>
  );
}

const HEAT_SERIES = [
  { id: "said", label: "Your messages" },
  { id: "commits", label: "Commits" },
  { id: "started", label: "Agents started" },
  { id: "opened", label: "Threads opened" },
];

function busiestHour(times: number[]): number | undefined {
  if (times.length === 0) return;
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const at of times) {
    const hour = Number(HOUR.format(at)) % 24;
    byHour[hour] = (byHour[hour] ?? 0) + 1;
  }
  return byHour.indexOf(Math.max(...byHour));
}

function SeriesPicker({ stats, series, onSeries }: { stats: Stats; series: string; onSeries: (id: string) => void }) {
  return <Segmented label="Series" options={HEAT_SERIES.filter(s => s.id !== "commits" || stats.gh.now.commitTimes !== undefined)} value={series} onChange={onSeries} />;
}

export function RhythmTile({ stats, className }: { stats: Stats; className?: string }) {
  const [series, setSeries] = useState("said");
  const [peek, setPeek] = useState<Peek>();
  const times = series === "commits" ? (stats.gh.now.commitTimes ?? []) : (stats.yarn.counts.find(c => c.id === series)?.at ?? []);
  const label = HEAT_SERIES.find(s => s.id === series)?.label ?? series;
  const peakHour = busiestHour(times);
  return (
    <Tile
      className={className}
      label="By hour this week"
      value={times.length.toLocaleString()}
      delta={peakHour !== undefined && <span className="text-xs text-[var(--viz-text-2)]">busiest around {hourLabel(peakHour)}</span>}
      peek={peek}
      aside={<SeriesPicker stats={stats} series={series} onSeries={setSeries} />}
    >
      <Heatmap times={times} days={stats.week.days} onPeek={setPeek} noun={label} />
    </Tile>
  );
}

export function ThroughputTile({ stats, className }: { stats: Stats; className?: string }) {
  const c = (id: string) => sum(stats.yarn.counts.find(x => x.id === id)?.days ?? []);
  const gh = stats.gh.now.counts;
  const funnels = [
    { title: "Threads", stages: [{ label: "Opened", value: c("opened") }, { label: "Resolved", value: c("resolved") }] },
    { title: "Agents' PRs", stages: [{ label: "Opened", value: c("prsOpened") }, { label: "Merged", value: c("prsMerged") }] },
    { title: `Your PRs on ${stats.gh.repo.split("/", 2)[1] ?? ""}`, stages: [{ label: "Opened", value: gh?.opened }, { label: "Merged", value: gh?.merged }, { label: "Closed unmerged", value: gh?.closed }] },
  ];
  return (
    <Tile className={className} label="Threads resolved" value={`${Math.round((c("resolved") / Math.max(1, c("opened"))) * 100)}%`} delta={<span className="text-xs text-[var(--viz-text-2)]">of those opened this week</span>}>
      {funnels.map(f => (
        <div key={f.title} className="flex flex-col gap-1">
          <div className="text-sm font-medium text-[var(--viz-text)]">{f.title}</div>
          <Stages stages={f.stages} />
        </div>
      ))}
    </Tile>
  );
}

function yarnLogNote({ yarn, week }: Stats) {
  if (week.to <= yarn.since) return "No yarn log reaches back to this week";
  if (week.from < yarn.since) return `Log starts ${new Date(yarn.since).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, so this week is partial`;
  return "";
}

export function YarnNote({ stats }: { stats: Stats }) {
  const text = yarnLogNote(stats);
  return text === "" ? null : <span className="text-xs text-[var(--viz-text-2)]">{text}</span>;
}
