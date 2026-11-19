import { useState } from "react";
import { cn, hasText } from "@/lib/utils";
import { useJson } from "./load";
import { SectionHead, Tile, short, type Peek, type Stats } from "./parts";
import { CountTiles, GhNote, GhTrendTiles, RepoPicker, RhythmTile, ThroughputTile, YarnNote } from "./sections";

type Calendar = { at: number; total: number; days: { date: string; count: number }[]; error?: string };
type Day = Calendar["days"][number];

const MONTH = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const LONG_DAY = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const SHADE_PERCENT = [0, 30, 55, 78, 100];
const SHADE_LEVELS = [0, 1, 2, 3, 4];
const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

function longestRun(days: Day[]) {
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

function runEndingTodayOrYesterday(days: Day[]) {
  const hasOneToday = (days.at(-1)?.count ?? 0) > 0;
  let current = 0;
  for (let i = days.length - (hasOneToday ? 1 : 2); i >= 0 && (days[i]?.count ?? 0) > 0; i--) current += 1;
  return current;
}

function quartileCuts(days: Day[]) {
  const busy = days
    .map(d => d.count)
    .filter(n => n > 0)
    .toSorted((a, b) => a - b);
  return [0.25, 0.5, 0.75].map(q => busy[Math.floor(q * (busy.length - 1))] ?? 0);
}

function shadeLevel(n: number, cuts: number[]) {
  const [q1 = 0, q2 = 0, q3 = 0] = cuts;
  if (n === 0) return 0;
  if (n <= q1) return 1;
  if (n <= q2) return 2;
  return n <= q3 ? 3 : 4;
}

const shade = (level: number) => (level === 0 ? "var(--viz-track)" : `color-mix(in oklab, var(--viz) ${SHADE_PERCENT[level] ?? 100}%, var(--viz-track))`);

const isSunday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0;

function weeksFromSunday(days: Day[]) {
  const weeks: Day[][] = [];
  for (const d of days) {
    const week = weeks.at(-1);
    if (week === undefined || isSunday(d.date)) weeks.push([d]);
    else week.push(d);
  }
  return weeks;
}

function CalendarFacts({ cal, weeks }: { cal: Calendar; weeks: Day[][] }) {
  const best = cal.days.reduce((a, b) => (b.count > a.count ? b : a), cal.days[0] ?? { date: "", count: 0 });
  const thisWeek = weeks.at(-1)?.reduce((n, d) => n + d.count, 0) ?? 0;
  return (
    <dl className="hidden shrink-0 grid-cols-4 gap-5 text-right sm:grid">
      {[
        ["This week", thisWeek.toLocaleString()],
        ["Current streak", `${runEndingTodayOrYesterday(cal.days)}d`],
        ["Longest streak", `${longestRun(cal.days)}d`],
        ["Best day", best.count > 0 ? `${best.count} · ${short(best.date)}` : "–"],
      ].map(([k, v]) => (
        <div key={k}>
          <dt className="text-[11px] text-muted-foreground">{k}</dt>
          <dd className="text-sm font-semibold tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

type WeekProps = { week: Day[]; previous: Day[] | undefined; isFirst: boolean; hasMonthRoom: boolean; cuts: number[]; onDay: (date: string) => void; onPeek: (p: Peek) => void };

function WeekColumn({ week, previous, isFirst, hasMonthRoom, cuts, onDay, onPeek }: WeekProps) {
  const first = week[0]?.date ?? "";
  const isNewMonth = isFirst || first.slice(5, 7) !== previous?.[0]?.date.slice(5, 7);
  const blanksBeforeGithubsFirstDay = isFirst ? 7 - week.length : 0;
  return (
    <div className="grid flex-1 grid-rows-[0.9rem_repeat(7,minmax(0,1fr))] gap-[3px]">
      <span className="whitespace-nowrap text-[10px] leading-none text-muted-foreground">{isNewMonth && hasMonthRoom ? MONTH.format(new Date(`${first}T12:00:00Z`)) : ""}</span>
      {Array.from({ length: blanksBeforeGithubsFirstDay }, (_, k) => (
        <span key={`pad${k}`} />
      ))}
      {week.map(d => (
        <button
          key={d.date}
          type="button"
          onClick={() => onDay(d.date)}
          onMouseEnter={() => onPeek({ value: d.count.toLocaleString(), label: `Contributions · ${LONG_DAY(d.date)}` })}
          className="aspect-square w-full rounded-[3px] outline-offset-1 hover:outline hover:outline-2 hover:outline-foreground/60"
          style={{ background: shade(shadeLevel(d.count, cuts)) }}
          title={`${d.count} on ${LONG_DAY(d.date)}`}
        />
      ))}
    </div>
  );
}

function ShadeLegend() {
  return (
    <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
      <span>Click a day to see its week below</span>
      <span className="flex items-center gap-1">
        Less
        {SHADE_LEVELS.map(l => (
          <span key={l} className="size-2.5 rounded-[3px]" style={{ background: shade(l) }} />
        ))}
        More
      </span>
    </div>
  );
}

function ContributionCalendar({ cal, onDay }: { cal: Calendar; onDay: (date: string) => void }) {
  const [peek, setPeek] = useState<Peek>();
  const cuts = quartileCuts(cal.days);
  const weeks = weeksFromSunday(cal.days);
  return (
    <Tile
      label="Contributions in the last year"
      value={cal.total.toLocaleString()}
      peek={peek}
      delta={<span className="text-xs text-muted-foreground">every repo, private ones counted as GitHub does</span>}
      aside={<CalendarFacts cal={cal} weeks={weeks} />}
    >
      <div className="mt-4 overflow-x-auto" onMouseLeave={() => setPeek(undefined)}>
        <div className="flex min-w-[42rem] gap-[3px]">
          <div className="mr-1 grid grid-rows-[0.9rem_repeat(7,minmax(0,1fr))] gap-[3px] text-[10px] text-muted-foreground">
            <span />
            {WEEKDAY_LABELS.map((d, i) => (
              <span key={i} className="leading-none self-center">
                {d}
              </span>
            ))}
          </div>
          {weeks.map((w, i) => (
            <WeekColumn key={w[0]?.date} week={w} previous={weeks[i - 1]} isFirst={i === 0} hasMonthRoom={i < weeks.length - 2} cuts={cuts} onDay={onDay} onPeek={setPeek} />
          ))}
        </div>
        <ShadeLegend />
      </div>
    </Tile>
  );
}

export function Overview({ stats, picked, onRepo, onWeek, live }: { stats: Stats; picked?: string | undefined; onRepo: (r: string) => void; onWeek: (k: string) => void; live: boolean }) {
  const cal = useJson<Calendar>(live ? "/api/stats/calendar" : undefined);
  return (
    <>
      <section>
        {cal.value && cal.value.days.length > 0 ? (
          <ContributionCalendar cal={cal.value} onDay={onWeek} />
        ) : (
          <Tile label="Contributions in the last year" value={hasText(cal.error) ? "–" : "…"}>
            <p className={cn("mt-2 text-xs", hasText(cal.error) || hasText(cal.value?.error) ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
              {cal.error ?? cal.value?.error ?? "Asking GitHub…"}
            </p>
          </Tile>
        )}
      </section>
      <section>
        <SectionHead title="GitHub this week">
          <RepoPicker stats={stats} picked={picked} onRepo={onRepo} />
          <GhNote stats={stats} />
        </SectionHead>
        <GhTrendTiles stats={stats} onWeek={onWeek} keys={["commits", "opened", "merged", "reviews"]} />
      </section>
      <section>
        <SectionHead title="What yarn turned out">
          <YarnNote stats={stats} />
        </SectionHead>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CountTiles stats={stats} ids={["resolved", "prsMerged", "started", "said"]} />
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
            <RhythmTile stats={stats} className="lg:col-span-3" />
            <ThroughputTile stats={stats} className="lg:col-span-2" />
          </div>
        </div>
      </section>
    </>
  );
}
