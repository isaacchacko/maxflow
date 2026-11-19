import { useState, type ReactNode } from "react";
import { Bar, BarChart, Rectangle, ResponsiveContainer, Tooltip, XAxis, type BarShapeProps, type MouseHandlerDataParam } from "recharts";
import { useNow } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";

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
export const JOURNEY = ["slack", "route", "reply", "ask"];
export const COUNT: Record<string, string> = {
  said: "Messages from you",
  started: "Agents started",
  opened: "Threads opened",
  resolved: "Threads resolved",
  prsOpened: "PRs opened by agents",
  prsMerged: "PRs merged",
};

export const SERVERS_WEEK_ZONE = "America/Los_Angeles";
export const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: SERVERS_WEEK_ZONE });
export const HOUR = new Intl.DateTimeFormat("en-US", { timeZone: SERVERS_WEEK_ZONE, hour: "numeric", hourCycle: "h23" });
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const short = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
export const weekday = (day: string, style: "narrow" | "short" = "narrow") => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: style, timeZone: "UTC" });

export function hourLabel(h: number) {
  if (h === 0) return "12am";
  if (h < 12) return `${h}am`;
  return h === 12 ? "12pm" : `${h - 12}pm`;
}

export function quantile(values: number[], q: number) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
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

export function useIsStillBefore(at: number | undefined) {
  const now = useNow(t => (at !== undefined && at > t ? Math.min(HOUR_MS, at - t) : HOUR_MS));
  return at !== undefined && at > now;
}

function deltaLook(pct: number, isLowerBetter: boolean) {
  if (pct === 0) return "bg-[var(--viz-track)] text-[var(--viz-text-2)]";
  const isGood = isLowerBetter ? pct < 0 : pct > 0;
  return isGood ? "bg-[var(--viz-up-bg)] text-[var(--viz-up)]" : "bg-[var(--viz-down-bg)] text-[var(--viz-down)]";
}

type DeltaProps = { now?: number | undefined; before?: number | undefined; isLowerBetter?: boolean; isWeekRunning?: boolean };

export function Delta({ now, before, isLowerBetter = false, isWeekRunning = false }: DeltaProps) {
  if (isWeekRunning && before !== undefined) return <span className="truncate text-[13px] font-medium whitespace-nowrap text-[var(--viz-text-3)] tabular-nums">{before.toLocaleString()} last week</span>;
  if (now === undefined || before === undefined || before === 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return (
    <span className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-sm font-medium whitespace-nowrap tabular-nums", deltaLook(pct, isLowerBetter))}>
      {pct > 0 ? "+" : ""}
      {pct}%
    </span>
  );
}

export type Peek = { value: string; label: string } | undefined;

type TileProps = { label: string; value: string; delta?: ReactNode; peek?: Peek; hint?: string | undefined; aside?: ReactNode; className?: string | undefined; children?: ReactNode };

export function Tile({ label, value, delta, peek, hint, aside, className, children }: TileProps) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-4 rounded-2xl bg-[var(--viz-tile)] px-4 pt-4 pb-3", className)} title={hint}>
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-sm font-medium text-[var(--viz-text-2)]">{peek?.label ?? label}</p>
          <div className="flex min-h-[2.125rem] min-w-0 items-center gap-2">
            <p key={peek?.value ?? value} className="animate-in fade-in text-2xl leading-[2.125rem] font-medium whitespace-nowrap text-[var(--viz-text)] tabular-nums duration-200">
              {peek?.value ?? value}
            </p>
            {!peek && delta}
          </div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function InnerStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-start rounded-[10px] bg-[var(--viz-inner)] p-2.5 shadow-[var(--viz-shadow)]">
      <p className="w-full truncate text-sm font-medium text-[var(--viz-text)] tabular-nums">{value}</p>
      <p className="w-full truncate text-sm font-medium text-[var(--viz-text-2)]">{label}</p>
    </div>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 items-start gap-0.5 rounded-[10px] bg-[var(--viz-tile)] p-1">
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded-md px-2.5 py-1 text-sm whitespace-nowrap transition-colors duration-200",
            value === o.id ? "bg-[var(--viz-seg)] font-medium text-[var(--viz-text)] shadow-[var(--viz-seg-shadow)]" : "text-[var(--viz-text-2)] hover:text-[var(--viz-text)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type ColumnsProps = {
  values: (number | undefined)[];
  labels: string[];
  ticks?: string[];
  strong: (i: number) => boolean;
  onPeek?: (p: Peek) => void;
  onPick?: (i: number) => void;
  height?: string;
  format?: (v: number) => string;
};

const localeNumber = (v: number) => v.toLocaleString();
export const AXIS_TICK = { fontSize: 13, fill: "var(--viz-text-3)" };
const BAR_RADIUS = 10;
const FADED = "color-mix(in srgb, var(--viz) 45%, var(--viz-track))";
const OUTLINE_INSET = 3;
const MIN_VISIBLE_BAR_PX = 6;
const visibleWhenAboveZero = (v: number | undefined | null) => (v !== undefined && v !== null && v > 0 ? MIN_VISIBLE_BAR_PX : 0);
export const indexOf = (state: MouseHandlerDataParam) => (state.isTooltipActive && state.activeTooltipIndex !== undefined ? Number(state.activeTooltipIndex) : undefined);

function anchorOf(i: number, isOnlyEnds: boolean) {
  if (!isOnlyEnds) return "middle";
  return i === 0 ? "start" : "end";
}

function edgeAnchoredTick(shown: Set<number>, count: number) {
  type TickProps = { x?: number | string; y?: number | string; payload?: { value?: unknown; index?: number } };
  return function EdgeAnchoredTick({ x = 0, y = 0, payload }: TickProps) {
    const i = payload?.index ?? 0;
    if (!shown.has(i)) return <g />;
    const anchor = anchorOf(i, shown.size === 2 && count > 2);
    return (
      <text x={Number(x)} y={Number(y)} dy={10} textAnchor={anchor} fontSize={AXIS_TICK.fontSize} fill={AXIS_TICK.fill}>
        {typeof payload?.value === "string" ? payload.value : ""}
      </text>
    );
  };
}

function shownTicks(count: number) {
  return new Set(count > 7 ? [0, count - 1] : Array.from({ length: count }, (_, i) => i));
}

function trackWithHoverOutline(hover: number | undefined) {
  type TrackProps = { x?: number; y?: number; width?: number; height?: number; index?: number };
  return function Track({ x = 0, y = 0, width = 0, height = 0, index }: TrackProps) {
    const radius = Math.min(BAR_RADIUS, width / 2);
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} rx={radius} ry={radius} fill="var(--viz-track)" />
        <rect
          x={x - OUTLINE_INSET}
          y={y - OUTLINE_INSET}
          width={width + 2 * OUTLINE_INSET}
          height={height + 2 * OUTLINE_INSET}
          rx={radius + OUTLINE_INSET}
          ry={radius + OUTLINE_INSET}
          fill="none"
          stroke="var(--viz-cursor)"
          strokeWidth={2}
          opacity={hover === index ? 1 : 0}
          className="transition-opacity duration-150 ease-out"
        />
      </g>
    );
  };
}

export function Columns({ values, labels, ticks: tickLabels = labels, strong, onPeek, onPick, height = "h-28", format = localeNumber }: ColumnsProps) {
  const [hover, setHover] = useState<number>();
  const rows = values.map((v, i) => ({ v, tick: tickLabels[i] ?? "" }));
  const ticks = shownTicks(values.length);
  const enter = (state: MouseHandlerDataParam) => {
    const i = indexOf(state);
    setHover(i);
    if (i === undefined) return;
    const v = values[i];
    onPeek?.({ value: v === undefined ? "–" : format(v), label: labels[i] ?? "" });
  };
  const leave = () => {
    setHover(undefined);
    onPeek?.(undefined);
  };
  const pick = (state: MouseHandlerDataParam) => {
    const i = indexOf(state);
    if (i !== undefined) onPick?.(i);
  };
  return (
    <div className={cn("min-h-0 w-full", height, onPick !== undefined && "cursor-pointer")}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: OUTLINE_INSET, right: OUTLINE_INSET, bottom: 0, left: OUTLINE_INSET }} barCategoryGap="22%" onMouseMove={enter} onMouseLeave={leave} onClick={pick}>
          <Tooltip content={() => null} cursor={false} />
          <XAxis dataKey="tick" interval={0} axisLine={false} tickLine={false} tickMargin={8} height={24} tick={edgeAnchoredTick(ticks, values.length)} />
          <Bar
            dataKey="v"
            radius={BAR_RADIUS}
            maxBarSize={32}
            minPointSize={visibleWhenAboveZero}
            background={trackWithHoverOutline(hover)}
            shape={(props: BarShapeProps) => <Rectangle {...props} fill={hover === props.index || strong(props.index) ? "var(--viz)" : FADED} />}
            isAnimationActive
            animationDuration={450}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export type StageRow = { key: string; label: string; value: number | undefined; note?: string | undefined; color?: string | undefined };

export function StageBars({ rows, fmt = localeNumber, top, onPeek }: { rows: StageRow[]; fmt?: (v: number) => string; top?: number; onPeek?: (p: Peek) => void }) {
  const [hover, setHover] = useState<string>();
  const most = top ?? Math.max(1e-9, ...rows.map(r => r.value ?? 0));
  const enter = (r: StageRow) => {
    setHover(r.key);
    onPeek?.({ value: r.value === undefined ? "–" : fmt(r.value), label: r.label });
  };
  const leave = () => {
    setHover(undefined);
    onPeek?.(undefined);
  };
  return (
    <div className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 py-1" onMouseLeave={leave}>
      {rows.map(r => {
        const isFaded = hover !== undefined && hover !== r.key;
        const width = r.value !== undefined && r.value > 0 ? `max(${(r.value / most) * 100}%, 1.25rem)` : "0%";
        return (
          <div key={r.key} className="contents" onMouseEnter={() => enter(r)}>
            <span className={cn("max-w-40 truncate text-end text-sm text-[var(--viz-text-2)] transition-opacity duration-200", isFaded && "opacity-40")} title={r.label}>
              {r.label}
            </span>
            <div className={cn("relative h-5 min-w-0 overflow-hidden rounded-full bg-[var(--viz-track)] transition-opacity duration-200", isFaded && "opacity-40")}>
              <div className="absolute inset-y-0 start-0 rounded-full transition-[width,background-color] duration-500 ease-out" style={{ width, background: hover === r.key ? "var(--viz-active)" : (r.color ?? "var(--viz)") }} />
            </div>
            <span className={cn("flex items-baseline justify-end gap-1.5 whitespace-nowrap transition-opacity duration-200", isFaded && "opacity-40")}>
              <span className="text-sm font-medium text-[var(--viz-text)] tabular-nums">{r.value === undefined ? "–" : fmt(r.value)}</span>
              {hasText(r.note) && <span className="text-xs font-medium text-[var(--viz-text-3)] tabular-nums">{r.note}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h2 className="text-base font-medium text-[var(--viz-text)]">{title}</h2>
      {children}
    </div>
  );
}
