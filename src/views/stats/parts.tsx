import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The Stats page's chart pieces, after BoardUI's chart cards: a tile whose headline is the number, a delta pill beside it, every
// mark drawn over a neutral track so an empty slot still reads as one, and hovering a mark swaps the headline to that mark's value.

export type Counts = { commits: number; opened: number; merged: number; closed: number; reviews: number; requested: number; added: number; deleted: number };
export type GhWeek = { at: number; final: boolean; counts?: Counts; commitTimes?: number[]; error?: string };
export type Latency = { id: string; samples: { at: number; ms: number }[] };
export type Count = { id: string; days: number[]; at: number[] };
export type YarnWeek = { since: number; latencies: Latency[]; counts: Count[] };
export type Trend = { pending: boolean; weeks: { key: string; counts?: Counts }[] };
export type Stats = {
  week: { key: string; from: number; to: number; days: string[] };
  gh: { repo: string; repos: string[]; now: GhWeek; before: GhWeek; trend: Trend };
  yarn: YarnWeek;
  yarnBefore: YarnWeek;
};

export const GH: { key: keyof Counts; label: string }[] = [
  { key: "commits", label: "Commits" },
  { key: "opened", label: "PRs opened" },
  { key: "merged", label: "PRs merged" },
  { key: "reviews", label: "Reviews given" },
  { key: "requested", label: "Reviews asked of you" },
  { key: "closed", label: "PRs closed unmerged" },
];
export const LATENCY: Record<string, { label: string; hint: string }> = {
  slack: { label: "Slack to yarn", hint: "A Slack message sent → yarn reporting it" },
  route: { label: "Time to route", hint: "Your message → the funnel routing it" },
  reply: { label: "Time to reply", hint: "Your thread message → an agent's first reply" },
  ask: { label: "Answer to action", hint: "Your answer to an agent's ask → its next message" },
};
// The order a request travels: Slack reaches yarn, gets routed, an agent answers, he answers back, the agent acts.
export const JOURNEY = ["slack", "route", "reply", "ask"];
export const COUNT: Record<string, string> = {
  said: "Messages from you",
  started: "Agents started",
  opened: "Threads opened",
  resolved: "Threads resolved",
  prsOpened: "PRs opened by agents",
  prsMerged: "PRs merged",
};

// Weeks are cut in his time zone on the server, so days and hours are keyed the same way here.
export const TZ = "America/Los_Angeles";
export const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
export const HOUR = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const short = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
export const weekday = (day: string, style: "narrow" | "short" = "narrow") => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: style, timeZone: "UTC" });
export const hourLabel = (h: number) => (h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`);

export function quantile(values: number[], q: number) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}
export const median = (values: number[]) => quantile(values, 0.5);
export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export function duration(ms: number | undefined) {
  if (ms === undefined) return "–";
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(s < 36_000 ? 1 : 0)}h`;
}

// ---- pieces

/** The change from last week as a pill, green when it went the good way. A total for a week still running can't be compared to a whole
 * one yet, so it names last week's total instead. */
export function Delta({ now, before, lowerIsBetter, running }: { now?: number; before?: number; lowerIsBetter?: boolean; running?: boolean }) {
  if (running && before !== undefined) return <span className="text-xs text-muted-foreground tabular-nums">{before.toLocaleString()} last week</span>;
  if (now === undefined || !before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-px text-xs font-medium tabular-nums",
        pct === 0 ? "bg-muted text-muted-foreground" : good ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/15 text-rose-700 dark:text-rose-300",
      )}
    >
      {pct > 0 ? "+" : ""}
      {pct}%
    </span>
  );
}

export type Peek = { value: string; label: string } | undefined;

/** A chart card: its label and headline on top, which a hovered mark takes over, then the chart. */
export function Tile({ label, value, delta, peek, hint, aside, className, children }: { label: string; value: string; delta?: ReactNode; peek?: Peek; hint?: string; aside?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("flex flex-col rounded-2xl bg-[var(--viz-tile)] p-4", className)} title={hint}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-muted-foreground">{peek?.label ?? label}</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-tight tabular-nums">{peek?.value ?? value}</span>
            {!peek && delta}
          </div>
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** Columns over full-height tracks, one per slot; `strong` slots wear the accent, the rest a lighter mix of it, and a hovered column
 * alone keeps its colour. */
export function Columns({ values, labels, ticks: tickLabels, strong, onPeek, onPick, height = "h-16", format = (v: number) => v.toLocaleString() }: {
  values: (number | undefined)[];
  labels: string[];
  ticks?: string[];
  strong: (i: number) => boolean;
  onPeek(p: Peek): void;
  onPick?(i: number): void;
  height?: string;
  format?(v: number): string;
}) {
  const [hover, setHover] = useState<number>();
  const max = Math.max(1, ...values.map(v => v ?? 0));
  const shown = tickLabels ?? labels;
  const ticks = labels.length > 7 ? [0, labels.length - 1] : labels.map((_, i) => i);
  return (
    <div className="mt-4">
      <div className={cn("flex items-end justify-between gap-[3px]", height)} onMouseLeave={() => (setHover(undefined), onPeek(undefined))}>
        {values.map((v, i) => {
          const lit = hover === undefined ? strong(i) : hover === i;
          return (
            <button
              key={i}
              type="button"
              onMouseEnter={() => (setHover(i), onPeek({ value: v === undefined ? "–" : format(v), label: labels[i]! }))}
              onClick={() => onPick?.(i)}
              className={cn("relative h-full max-w-9 flex-1 overflow-hidden rounded-[6px] bg-[var(--viz-track)]", !onPick && "cursor-default")}
            >
              <span
                className="absolute inset-x-0 bottom-0 rounded-[6px] transition-[height,background-color] duration-300"
                style={{ height: v ? `max(${(v / max) * 100}%, 4px)` : 0, background: lit ? "var(--viz)" : "color-mix(in oklab, var(--viz) 40%, var(--viz-track))" }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between gap-[3px] text-[10px] leading-none text-muted-foreground">
        {shown.map((l, i) => (
          <span key={i} className={cn("max-w-9 flex-1 whitespace-nowrap", ticks.length === 2 ? (i === shown.length - 1 ? "flex justify-end" : "") : "text-center")}>
            {ticks.includes(i) ? l : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Hour × weekday cells, each mixing the accent into the track by its count, with a less-to-more key. */
export function Heatmap({ times, days, onPeek, noun }: { times: number[]; days: string[]; onPeek(p: Peek): void; noun: string }) {
  const grid = days.map(() => Array<number>(24).fill(0));
  for (const at of times) {
    const d = days.indexOf(DAY_KEY.format(at));
    if (d >= 0) grid[d]![Number(HOUR.format(at)) % 24]!++;
  }
  const max = Math.max(1, ...grid.flat());
  const [hover, setHover] = useState<[number, number]>();
  return (
    <div className="mt-4" onMouseLeave={() => (setHover(undefined), onPeek(undefined))}>
      <div className="grid grid-cols-[2.25rem_repeat(24,minmax(0,1fr))] gap-[3px]">
        {grid.map((row, d) => (
          <div key={days[d]} className="contents">
            <span className={cn("self-center text-[10px] text-muted-foreground", hover?.[0] === d && "text-foreground")}>{weekday(days[d]!, "short")}</span>
            {row.map((n, h) => (
              <span
                key={h}
                onMouseEnter={() => (setHover([d, h]), onPeek({ value: n.toLocaleString(), label: `${noun} · ${weekday(days[d]!, "short")} ${short(days[d]!)}, ${hourLabel(h)}–${hourLabel((h + 1) % 24)}` }))}
                className={cn("aspect-square rounded-[4px]", hover && hover[0] === d && hover[1] === h && "ring-2 ring-foreground/70")}
                style={{ background: n ? `color-mix(in oklab, var(--viz) ${18 + 82 * (n / max)}%, var(--viz-track))` : "var(--viz-track)" }}
              />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className={cn("text-center text-[10px] text-muted-foreground", hover?.[1] === h && "text-foreground")}>
            {h % 6 === 0 ? hourLabel(h) : ""}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
        Less
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <span key={f} className="size-2.5 rounded-[3px]" style={{ background: f ? `color-mix(in oklab, var(--viz) ${18 + 82 * f}%, var(--viz-track))` : "var(--viz-track)" }} />
        ))}
        More
      </div>
    </div>
  );
}

// Latencies run from under a second to hours, so they share one log axis.
export const AXIS_MIN = 500, AXIS_MAX = 6 * 3600_000;
export const xOf = (ms: number) => Math.min(1, Math.max(0, Math.log(ms / AXIS_MIN) / Math.log(AXIS_MAX / AXIS_MIN)));
export const msAt = (x: number) => AXIS_MIN * Math.pow(AXIS_MAX / AXIS_MIN, x);
export const AXIS_TICKS = [1000, 10_000, 60_000, 600_000, 3600_000];

/** Every sample of each latency as a dot on a shared log axis, its middle half as a band and its median as a tick; the cursor reads off
 * how many came in faster than the time under it. */
export function Distributions({ latencies, before }: { latencies: Latency[]; before: YarnWeek }) {
  const [cursor, setCursor] = useState<{ id: string; x: number }>();
  const ordered = JOURNEY.map(id => latencies.find(l => l.id === id)).filter((l): l is Latency => !!l);
  return (
    <div className="mt-3 flex flex-col gap-2">
      {ordered.map(l => {
        const ms = l.samples.map(s => s.ms);
        const p25 = quantile(ms, 0.25), p50 = median(ms), p75 = quantile(ms, 0.75), p90 = quantile(ms, 0.9);
        const prev = median(before.latencies.find(p => p.id === l.id)?.samples.map(s => s.ms) ?? []);
        const at = cursor?.id === l.id ? msAt(cursor.x) : undefined;
        const meta = LATENCY[l.id] ?? { label: l.id, hint: "" };
        return (
          <div key={l.id} className="grid grid-cols-[8.5rem_minmax(0,1fr)_8rem] items-center gap-3" title={meta.hint}>
            <div className="min-w-0">
              <div className="truncate text-xs text-muted-foreground">{meta.label}</div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-lg font-semibold tabular-nums">{duration(p50)}</span>
                <Delta now={p50} before={prev} lowerIsBetter />
              </div>
            </div>
            <div
              className="relative h-10 cursor-crosshair rounded-xl bg-[var(--viz-track)]"
              onMouseMove={e => {
                const r = e.currentTarget.getBoundingClientRect();
                setCursor({ id: l.id, x: (e.clientX - r.left) / r.width });
              }}
              onMouseLeave={() => setCursor(undefined)}
            >
              {AXIS_TICKS.map(t => (
                <span key={t} className="absolute inset-y-1 w-px bg-foreground/5" style={{ left: `${xOf(t) * 100}%` }} />
              ))}
              {p25 !== undefined && (
                <span className="absolute inset-y-1.5 rounded-lg" style={{ left: `${xOf(p25) * 100}%`, width: `${(xOf(p75!) - xOf(p25)) * 100}%`, background: "color-mix(in oklab, var(--viz) 22%, transparent)" }} />
              )}
              {l.samples.map((s, i) => (
                <span
                  key={i}
                  className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{ left: `${xOf(s.ms) * 100}%`, top: `${22 + ((i * 2654435761) % 1000) / 1000 * 56}%`, background: "var(--viz)", opacity: ms.length > 200 ? 0.35 : 0.6 }}
                />
              ))}
              {p50 !== undefined && <span className="absolute inset-y-0.5 w-[3px] -translate-x-1/2 rounded-full bg-foreground" style={{ left: `${xOf(p50) * 100}%` }} />}
              {at !== undefined && <span className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${cursor!.x * 100}%` }} />}
            </div>
            <div className="text-right text-xs text-muted-foreground tabular-nums">
              {at !== undefined ? (
                <>
                  <span className="text-foreground">{Math.round((ms.filter(v => v <= at).length / Math.max(1, ms.length)) * 100)}%</span> under {duration(at)}
                </>
              ) : (
                <>
                  p90 {duration(p90)} · {ms.length}
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_8rem] gap-3">
        <span />
        <div className="relative h-3 text-[10px] text-muted-foreground">
          {AXIS_TICKS.map(t => (
            <span key={t} className="absolute -translate-x-1/2" style={{ left: `${xOf(t) * 100}%` }}>
              {duration(t)}
            </span>
          ))}
        </div>
        <span className="text-right text-[10px] text-muted-foreground">bar median · band middle half</span>
      </div>
    </div>
  );
}

/** A funnel as a list: each stage a pill over the track, sized to the first stage, with its count and share. */
export function Stages({ stages }: { stages: { label: string; value: number | undefined }[] }) {
  const top = stages[0]?.value || 1;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {stages.map(s => (
        <div key={s.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)_5.5rem] items-center gap-3">
          <span className="truncate text-right text-xs text-muted-foreground">{s.label}</span>
          <span className="relative h-3 overflow-hidden rounded-full bg-[var(--viz-track)]">
            <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--viz)] transition-[width] duration-500" style={{ width: s.value ? `max(${(s.value / top) * 100}%, 1rem)` : 0 }} />
          </span>
          <span className="text-xs tabular-nums">
            {s.value?.toLocaleString() ?? "–"} <span className="text-muted-foreground">{s.value !== undefined ? `${Math.round((s.value / top) * 100)}%` : ""}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- sections

export function RepoPicker({ stats, picked, onRepo }: { stats: Stats; picked?: string; onRepo(repo: string): void }) {
  return (
    <select value={picked ?? stats.gh.repo} onChange={e => onRepo(e.target.value)} className="max-w-64 rounded-md border bg-transparent px-1.5 py-0.5 text-xs" title="Repo">
      {stats.gh.repos.map(r => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </div>
  );
}

export function GhNote({ stats }: { stats: Stats }) {
  const { now, trend } = stats.gh;
  return (
    <span className="text-xs text-muted-foreground">
      checked {new Date(now.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      {trend.pending && " · filling in earlier weeks…"}
      {now.error && <span className="text-rose-600 dark:text-rose-400"> · last fetch failed{now.counts ? ", showing older numbers" : ""}</span>}
    </span>
  );
}

/** One tile per GitHub count: the week's number, its change, and the twelve weeks up to it as columns (click one to go there). */
export function GhTrendTiles({ stats, onWeek, keys = GH.map(g => g.key) }: { stats: Stats; onWeek(key: string): void; keys?: (keyof Counts)[] }) {
  const { now, before, trend } = stats.gh;
  const running = stats.week.to > Date.now();
  const [peeks, setPeeks] = useState<Record<string, Peek>>({});
  const labels = trend.weeks.map(w => `Week of ${short(w.key)}`);
  const tiles = [
    ...GH.filter(g => keys.includes(g.key)).map(g => ({ id: g.key, label: g.label, value: (c?: Counts) => c?.[g.key] })),
    { id: "lines", label: "Lines changed in merged PRs", value: (c?: Counts) => c && c.added + c.deleted },
  ];
  return (
    <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", tiles.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
      {tiles.map(t => (
        <Tile
          key={t.id}
          label={t.label}
          value={t.value(now.counts)?.toLocaleString() ?? "–"}
          delta={<Delta now={t.value(now.counts)} before={t.value(before.counts)} running={running} />}
          peek={peeks[t.id]}
        >
          <Columns
            values={trend.weeks.map(w => t.value(w.counts))}
            labels={labels}
            ticks={trend.weeks.map(w => short(w.key))}
            strong={i => i === trend.weeks.length - 1}
            onPeek={p => setPeeks(x => ({ ...x, [t.id]: p }))}
            onPick={i => onWeek(trend.weeks[i]!.key)}
            height="h-14"
          />
        </Tile>
      ))}
    </div>
  );
}

/** Each latency's median with its day-by-day medians as columns. */
export function LatencyTiles({ stats }: { stats: Stats }) {
  const { yarn, yarnBefore, week } = stats;
  const [peeks, setPeeks] = useState<Record<string, Peek>>({});
  return (
    <>
      {JOURNEY.map(id => yarn.latencies.find(l => l.id === id)).filter((l): l is Latency => !!l).map(l => {
        const ms = l.samples.map(s => s.ms);
        const prev = median(yarnBefore.latencies.find(p => p.id === l.id)?.samples.map(s => s.ms) ?? []);
        const byDay = week.days.map(d => median(l.samples.filter(s => DAY_KEY.format(s.at) === d).map(s => s.ms)));
        const meta = LATENCY[l.id] ?? { label: l.id, hint: "" };
        return (
          <Tile key={l.id} label={meta.label} hint={meta.hint} value={duration(median(ms))} delta={<Delta now={median(ms)} before={prev} lowerIsBetter />} peek={peeks[l.id]}>
            <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">p90 {duration(quantile(ms, 0.9))} · {ms.length} times</div>
            <Columns
              values={byDay}
              labels={week.days.map(d => weekday(d))}
              strong={() => true}
              format={duration}
              onPeek={p => setPeeks(x => ({ ...x, [l.id]: p && { ...p, label: `${meta.label} · median` } }))}
            />
          </Tile>
        );
      })}
    </>
  );
}

export function CountTiles({ stats, ids }: { stats: Stats; ids?: string[] }) {
  const { yarn, yarnBefore, week } = stats;
  const running = week.to > Date.now();
  const [peeks, setPeeks] = useState<Record<string, Peek>>({});
  return (
    <>
      {yarn.counts.filter(c => !ids || ids.includes(c.id)).map(c => {
        const prev = yarnBefore.counts.find(p => p.id === c.id);
        return (
          <Tile key={c.id} label={COUNT[c.id] ?? c.id} value={sum(c.days).toLocaleString()} delta={<Delta now={sum(c.days)} before={yarn.since > week.from - 7 * 86_400_000 ? undefined : prev && sum(prev.days)} running={running} />} peek={peeks[c.id]}>
            <Columns values={c.days} labels={week.days.map(d => weekday(d))} strong={() => true} onPeek={p => setPeeks(x => ({ ...x, [c.id]: p && { ...p, label: `${COUNT[c.id]} · ${p.label}` } }))} />
          </Tile>
        );
      })}
    </>
  );
}

export const HEAT_SERIES = [
  { id: "said", label: "Your messages" },
  { id: "commits", label: "Commits" },
  { id: "started", label: "Agents started" },
  { id: "opened", label: "Threads opened" },
];

/** When the week happened: one of his activity series by hour and weekday. */
export function RhythmTile({ stats, className }: { stats: Stats; className?: string }) {
  const [series, setSeries] = useState("said");
  const [peek, setPeek] = useState<Peek>();
  const times = (id: string) => (id === "commits" ? (stats.gh.now.commitTimes ?? []) : (stats.yarn.counts.find(c => c.id === id)?.at ?? []));
  const label = HEAT_SERIES.find(s => s.id === series)!.label;
  const all = times(series);
  // The busiest hour of the day, across the week.
  const byHour = Array<number>(24).fill(0);
  for (const at of all) byHour[Number(HOUR.format(at)) % 24]!++;
  const peakHour = all.length ? byHour.indexOf(Math.max(...byHour)) : undefined;
  return (
    <Tile
      className={className}
      label={`${label} this week`}
      value={all.length.toLocaleString()}
      delta={peakHour !== undefined && <span className="text-xs text-muted-foreground">busiest around {hourLabel(peakHour)}</span>}
      peek={peek}
      aside={
        <div className="flex shrink-0 rounded-lg bg-[var(--viz-track)] p-0.5 text-xs">
          {HEAT_SERIES.filter(s => s.id !== "commits" || stats.gh.now.commitTimes).map(s => (
            <button key={s.id} onClick={() => setSeries(s.id)} className={cn("rounded-md px-2 py-0.5", series === s.id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {s.label}
            </button>
          ))}
        </div>
      }
    >
      <Heatmap times={all} days={stats.week.days} onPeek={setPeek} noun={label} />
    </Tile>
  );
}

/** Three funnels, each sized to its own first stage: threads he started getting resolved, agents' PRs merging, and his own. */
export function ThroughputTile({ stats, className }: { stats: Stats; className?: string }) {
  const c = (id: string) => sum(stats.yarn.counts.find(x => x.id === id)?.days ?? []);
  const gh = stats.gh.now.counts;
  const funnels = [
    { title: "Threads", stages: [{ label: "Opened", value: c("opened") }, { label: "Resolved", value: c("resolved") }] },
    { title: "Agents' PRs", stages: [{ label: "Opened", value: c("prsOpened") }, { label: "Merged", value: c("prsMerged") }] },
    { title: `Your PRs on ${stats.gh.repo.split("/")[1]}`, stages: [{ label: "Opened", value: gh?.opened }, { label: "Merged", value: gh?.merged }, { label: "Closed unmerged", value: gh?.closed }] },
  ];
  return (
    <Tile className={className} label="Threads resolved" value={`${Math.round((c("resolved") / Math.max(1, c("opened"))) * 100)}%`} delta={<span className="text-xs text-muted-foreground">of those opened this week</span>}>
      {funnels.map(f => (
        <div key={f.title} className="mt-4">
          <div className="text-xs font-medium">{f.title}</div>
          <Stages stages={f.stages} />
        </div>
      ))}
    </Tile>
  );
}

export function YarnNote({ stats }: { stats: Stats }) {
  const { yarn, week } = stats;
  const text =
    week.to <= yarn.since
      ? "No yarn log reaches back to this week"
      : week.from < yarn.since
        ? `Log starts ${new Date(yarn.since).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, so this week is partial`
        : "";
  return text ? <span className="text-xs text-muted-foreground">{text}</span> : null;
}

