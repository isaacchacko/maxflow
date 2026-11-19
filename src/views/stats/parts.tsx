import { useState, type ReactNode } from "react";
import { useNow } from "@/lib/effects";
import { cn } from "@/lib/utils";

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
  if (pct === 0) return "bg-muted text-muted-foreground";
  const isGood = isLowerBetter ? pct < 0 : pct > 0;
  return isGood ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/15 text-rose-700 dark:text-rose-300";
}

type DeltaProps = { now?: number | undefined; before?: number | undefined; isLowerBetter?: boolean; isWeekRunning?: boolean };

export function Delta({ now, before, isLowerBetter = false, isWeekRunning = false }: DeltaProps) {
  if (isWeekRunning && before !== undefined) return <span className="text-xs text-muted-foreground tabular-nums">{before.toLocaleString()} last week</span>;
  if (now === undefined || before === undefined || before === 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return (
    <span className={cn("rounded-md px-1.5 py-px text-xs font-medium tabular-nums", deltaLook(pct, isLowerBetter))}>
      {pct > 0 ? "+" : ""}
      {pct}%
    </span>
  );
}

export type Peek = { value: string; label: string } | undefined;

type TileProps = { label: string; value: string; delta?: ReactNode; peek?: Peek; hint?: string | undefined; aside?: ReactNode; className?: string | undefined; children?: ReactNode };

export function Tile({ label, value, delta, peek, hint, aside, className, children }: TileProps) {
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

function tickPlace(isOnlyEnds: boolean, isLast: boolean) {
  if (!isOnlyEnds) return "text-center";
  return isLast ? "flex justify-end" : "";
}

function Column({ v, max, isLit, isPickable, onEnter, onPick }: { v: number | undefined; max: number; isLit: boolean; isPickable: boolean; onEnter: () => void; onPick: () => void }) {
  return (
    <button type="button" onMouseEnter={onEnter} onClick={onPick} className={cn("relative h-full max-w-9 flex-1 overflow-hidden rounded-[6px] bg-[var(--viz-track)]", !isPickable && "cursor-default")}>
      <span
        className="absolute inset-x-0 bottom-0 rounded-[6px] transition-[height,background-color] duration-300"
        style={{ height: v !== undefined && v > 0 ? `max(${(v / max) * 100}%, 4px)` : 0, background: isLit ? "var(--viz)" : "color-mix(in oklab, var(--viz) 40%, var(--viz-track))" }}
      />
    </button>
  );
}

export function Columns({ values, labels, ticks: tickLabels = labels, strong, onPeek, onPick, height = "h-16", format = localeNumber }: ColumnsProps) {
  const [hover, setHover] = useState<number>();
  const max = Math.max(1, ...values.map((v = 0) => v));
  const ticks = labels.length > 7 ? [0, labels.length - 1] : labels.map((_, i) => i);
  const leave = () => {
    setHover(undefined);
    onPeek?.(undefined);
  };
  const enter = (i: number, v: number | undefined) => {
    setHover(i);
    onPeek?.({ value: v === undefined ? "–" : format(v), label: labels[i] ?? "" });
  };
  return (
    <div className="mt-4">
      <div className={cn("flex items-end justify-between gap-[3px]", height)} onMouseLeave={leave}>
        {values.map((v, i) => (
          <Column key={i} v={v} max={max} isLit={hover === undefined ? strong(i) : hover === i} isPickable={onPick !== undefined} onEnter={() => enter(i, v)} onPick={() => onPick?.(i)} />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between gap-[3px] text-[10px] leading-none text-muted-foreground">
        {tickLabels.map((l, i) => (
          <span key={i} className={cn("max-w-9 flex-1 whitespace-nowrap", tickPlace(ticks.length === 2, i === tickLabels.length - 1))}>
            {ticks.includes(i) ? l : ""}
          </span>
        ))}
      </div>
    </div>
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
