import { useState } from "react";
import { cn } from "@/lib/utils";
import { DAY_KEY, Delta, ShadeKey, StageBars, HOUR, HOUR_MS, JOURNEY, LATENCY, duration, hourLabel, median, quantile, short, weekday, type Latency, type Peek, type YarnWeek } from "./parts";

const heat = (fraction: number) => (fraction > 0 ? `color-mix(in oklab, var(--viz) ${Math.round(18 + 82 * fraction)}%, var(--viz-track))` : "var(--viz-track)");
const HEAT_KEY = [0, 0.25, 0.5, 0.75, 1].map(heat);
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const HOURS_BETWEEN_LABELS = 3;

function countsByDayAndHour(times: number[], days: string[]) {
  const grid = days.map(() => HOURS.map(() => 0));
  for (const at of times) {
    const row = grid[days.indexOf(DAY_KEY.format(at))];
    const hour = Number(HOUR.format(at)) % 24;
    if (row) row[hour] = (row[hour] ?? 0) + 1;
  }
  return grid;
}

const labelTone = (isLit: boolean) => (isLit ? "text-[var(--viz-text)]" : "text-[var(--viz-text-3)]");

export function Heatmap({ times, days, onPeek, noun }: { times: number[]; days: string[]; onPeek: (p: Peek) => void; noun: string }) {
  const grid = countsByDayAndHour(times, days);
  const max = Math.max(1, ...grid.flat());
  const [hover, setHover] = useState<[number, number]>();
  const leave = () => {
    setHover(undefined);
    onPeek(undefined);
  };
  const enter = (d: number, h: number) => {
    const day = days[d] ?? "";
    setHover([d, h]);
    onPeek({ value: (grid[d]?.[h] ?? 0).toLocaleString(), label: `${noun} · ${weekday(day, "short")} ${short(day)}, ${hourLabel(h)}–${hourLabel((h + 1) % 24)}` });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5" onMouseLeave={leave}>
      <div className="grid h-52 w-full gap-[3px] p-0.5" style={{ gridTemplateColumns: `2.5rem repeat(24, minmax(0, 1fr))`, gridTemplateRows: `repeat(${days.length}, minmax(0, 1fr)) auto` }}>
        {days.map((day, d) => (
          <div key={day} className="contents">
            <span className={cn("self-center text-[11px] transition-colors duration-150", labelTone(hover?.[0] === d))}>{weekday(day, "short")}</span>
            {(grid[d] ?? []).map((n, h) => (
              <div
                key={h}
                role="img"
                aria-label={`${weekday(day, "short")} ${hourLabel(h)}: ${n}`}
                onMouseEnter={() => enter(d, h)}
                className={cn("min-h-0 rounded-[3px] outline-offset-1", hover?.[0] === d && hover[1] === h && "outline-2 outline-[var(--viz-text-2)]")}
                style={{ background: heat(n / max) }}
              />
            ))}
          </div>
        ))}
        <span aria-hidden="true" />
        {HOURS.map(h => (
          <span key={h} className={cn("mt-1 text-left text-[11px] leading-none whitespace-nowrap transition-colors duration-150", labelTone(hover?.[1] === h))}>
            {h % HOURS_BETWEEN_LABELS === 0 ? hourLabel(h) : ""}
          </span>
        ))}
      </div>
      <ShadeKey shades={HEAT_KEY} />
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
      className="relative h-10 cursor-crosshair rounded-[10px] bg-[var(--viz-track)]"
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
        <div className="truncate text-sm font-medium text-[var(--viz-text-2)]">{meta.label}</div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-medium text-[var(--viz-text)] tabular-nums">{duration(p50)}</span>
          <Delta now={p50} before={prev} isLowerBetter />
        </div>
      </div>
      <LatencyStrip l={l} ms={ms} cursorX={cursorX} onCursor={onCursor} />
      <div className="text-right text-xs text-[var(--viz-text-2)] tabular-nums">
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
        <div className="relative h-3 text-[10px] text-[var(--viz-text-2)]">
          {AXIS_TICKS.map(t => (
            <span key={t} className="absolute -translate-x-1/2" style={{ left: `${xOf(t) * 100}%` }}>
              {duration(t)}
            </span>
          ))}
        </div>
        <span className="text-right text-[10px] text-[var(--viz-text-2)]">bar median · band middle half</span>
      </div>
    </div>
  );
}

export function Stages({ stages }: { stages: { label: string; value: number | undefined }[] }) {
  const first = stages[0]?.value;
  const top = first === undefined || first === 0 ? 1 : first;
  return <StageBars rows={stages.map(s => ({ key: s.label, label: s.label, value: s.value, note: s.value === undefined ? undefined : `${Math.round((s.value / top) * 100)}%` }))} top={top} />;
}
