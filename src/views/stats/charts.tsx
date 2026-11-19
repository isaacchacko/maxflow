import { useState } from "react";
import { cn } from "@/lib/utils";
import { DAY_KEY, Delta, HOUR, HOUR_MS, JOURNEY, LATENCY, duration, hourLabel, median, quantile, short, weekday, type Latency, type Peek, type YarnWeek } from "./parts";

const HEAT_KEY = [0, 0.25, 0.5, 0.75, 1];
const heat = (fraction: number) => (fraction > 0 ? `color-mix(in oklab, var(--viz) ${18 + 82 * fraction}%, var(--viz-track))` : "var(--viz-track)");

function countsByDayAndHour(times: number[], days: string[]) {
  const grid = days.map(() => Array.from({ length: 24 }, () => 0));
  for (const at of times) {
    const row = grid[days.indexOf(DAY_KEY.format(at))];
    const hour = Number(HOUR.format(at)) % 24;
    if (row) row[hour] = (row[hour] ?? 0) + 1;
  }
  return grid;
}

type HeatRowProps = { day: string; row: number[]; d: number; max: number; hover: [number, number] | undefined; onEnter: (h: number, n: number) => void };

function HeatRow({ day, row, d, max, hover, onEnter }: HeatRowProps) {
  return (
    <div className="contents">
      <span className={cn("self-center text-[10px] text-muted-foreground", hover?.[0] === d && "text-foreground")}>{weekday(day, "short")}</span>
      {row.map((n, h) => (
        <span
          key={h}
          onMouseEnter={() => onEnter(h, n)}
          className={cn("aspect-square rounded-[4px]", hover?.[0] === d && hover[1] === h && "ring-2 ring-foreground/70")}
          style={{ background: heat(n / max) }}
        />
      ))}
    </div>
  );
}

export function Heatmap({ times, days, onPeek, noun }: { times: number[]; days: string[]; onPeek: (p: Peek) => void; noun: string }) {
  const grid = countsByDayAndHour(times, days);
  const max = Math.max(1, ...grid.flat());
  const [hover, setHover] = useState<[number, number]>();
  const leave = () => {
    setHover(undefined);
    onPeek(undefined);
  };
  const enter = (d: number, day: string, h: number, n: number) => {
    setHover([d, h]);
    onPeek({ value: n.toLocaleString(), label: `${noun} · ${weekday(day, "short")} ${short(day)}, ${hourLabel(h)}–${hourLabel((h + 1) % 24)}` });
  };
  return (
    <div className="mt-4" onMouseLeave={leave}>
      <div className="grid grid-cols-[2.25rem_repeat(24,minmax(0,1fr))] gap-[3px]">
        {days.map((day, d) => (
          <HeatRow key={day} day={day} row={grid[d] ?? []} d={d} max={max} hover={hover} onEnter={(h, n) => enter(d, day, h, n)} />
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
        {HEAT_KEY.map(f => (
          <span key={f} className="size-2.5 rounded-[3px]" style={{ background: heat(f) }} />
        ))}
        More
      </div>
    </div>
  );
}

const LOG_AXIS_MIN_MS = 500;
const LOG_AXIS_MAX_MS = 6 * HOUR_MS;
const xOf = (ms: number) => Math.min(1, Math.max(0, Math.log(ms / LOG_AXIS_MIN_MS) / Math.log(LOG_AXIS_MAX_MS / LOG_AXIS_MIN_MS)));
const msAt = (x: number) => LOG_AXIS_MIN_MS * Math.pow(LOG_AXIS_MAX_MS / LOG_AXIS_MIN_MS, x);
const AXIS_TICKS = [1000, 10_000, 60_000, 600_000, HOUR_MS];
const DOT_SCATTER_HASH = 2_654_435_761;

export const inJourneyOrder = (latencies: Latency[]) => JOURNEY.map(id => latencies.find(l => l.id === id)).filter(l => l !== undefined);

type Cursor = { id: string; x: number } | undefined;

function LatencyStrip({ l, ms, cursorX, onCursor }: { l: Latency; ms: number[]; cursorX: number | undefined; onCursor: (cursor: Cursor) => void }) {
  const p25 = quantile(ms, 0.25);
  const p50 = median(ms);
  const p75 = quantile(ms, 0.75);
  return (
    <div
      className="relative h-10 cursor-crosshair rounded-xl bg-[var(--viz-track)]"
      onMouseMove={e => {
        const r = e.currentTarget.getBoundingClientRect();
        onCursor({ id: l.id, x: (e.clientX - r.left) / r.width });
      }}
      onMouseLeave={() => onCursor(undefined)}
    >
      {AXIS_TICKS.map(t => (
        <span key={t} className="absolute inset-y-1 w-px bg-foreground/5" style={{ left: `${xOf(t) * 100}%` }} />
      ))}
      {p25 !== undefined && p75 !== undefined && (
        <span className="absolute inset-y-1.5 rounded-lg" style={{ left: `${xOf(p25) * 100}%`, width: `${(xOf(p75) - xOf(p25)) * 100}%`, background: "color-mix(in oklab, var(--viz) 22%, transparent)" }} />
      )}
      {l.samples.map((s, i) => (
        <span
          key={i}
          className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${xOf(s.ms) * 100}%`, top: `${22 + (((i * DOT_SCATTER_HASH) % 1000) / 1000) * 56}%`, background: "var(--viz)", opacity: ms.length > 200 ? 0.35 : 0.6 }}
        />
      ))}
      {p50 !== undefined && <span className="absolute inset-y-0.5 w-[3px] -translate-x-1/2 rounded-full bg-foreground" style={{ left: `${xOf(p50) * 100}%` }} />}
      {cursorX !== undefined && <span className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${cursorX * 100}%` }} />}
    </div>
  );
}

function LatencyRow({ l, before, cursor, onCursor }: { l: Latency; before: YarnWeek; cursor: Cursor; onCursor: (cursor: Cursor) => void }) {
  const ms = l.samples.map(s => s.ms);
  const p50 = median(ms);
  const prev = median(before.latencies.find(p => p.id === l.id)?.samples.map(s => s.ms) ?? []);
  const cursorX = cursor?.id === l.id ? cursor.x : undefined;
  const at = cursorX === undefined ? undefined : msAt(cursorX);
  const meta = LATENCY[l.id] ?? { label: l.id, hint: "" };
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_8rem] items-center gap-3" title={meta.hint}>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{meta.label}</div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-semibold tabular-nums">{duration(p50)}</span>
          <Delta now={p50} before={prev} isLowerBetter />
        </div>
      </div>
      <LatencyStrip l={l} ms={ms} cursorX={cursorX} onCursor={onCursor} />
      <div className="text-right text-xs text-muted-foreground tabular-nums">
        {at === undefined ? (
          <>
            p90 {duration(quantile(ms, 0.9))} · {ms.length}
          </>
        ) : (
          <>
            <span className="text-foreground">{Math.round((ms.filter(v => v <= at).length / Math.max(1, ms.length)) * 100)}%</span> under {duration(at)}
          </>
        )}
      </div>
    </div>
  );
}

export function Distributions({ latencies, before }: { latencies: Latency[]; before: YarnWeek }) {
  const [cursor, setCursor] = useState<Cursor>();
  return (
    <div className="mt-3 flex flex-col gap-2">
      {inJourneyOrder(latencies).map(l => (
        <LatencyRow key={l.id} l={l} before={before} cursor={cursor} onCursor={setCursor} />
      ))}
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

export function Stages({ stages }: { stages: { label: string; value: number | undefined }[] }) {
  const first = stages[0]?.value;
  const top = first === undefined || first === 0 ? 1 : first;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {stages.map(s => (
        <div key={s.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)_5.5rem] items-center gap-3">
          <span className="truncate text-right text-xs text-muted-foreground">{s.label}</span>
          <span className="relative h-3 overflow-hidden rounded-full bg-[var(--viz-track)]">
            <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--viz)] transition-[width] duration-500" style={{ width: s.value !== undefined && s.value > 0 ? `max(${(s.value / top) * 100}%, 1rem)` : 0 }} />
          </span>
          <span className="text-xs tabular-nums">
            {s.value?.toLocaleString() ?? "–"} <span className="text-muted-foreground">{s.value === undefined ? "" : `${Math.round((s.value / top) * 100)}%`}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
