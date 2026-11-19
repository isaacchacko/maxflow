import { useState } from "react";
import { cn, hasText } from "@/lib/utils";
import { useJson } from "./load";
import { InnerStat, SectionHead, Tile, short, type Peek, type Stats } from "./parts";
import { CountTiles, GhNote, GhTrendTiles, RepoPicker, RhythmTile, ThroughputTile, YarnNote } from "./sections";

type Calendar = { at: number; total: number; days: { date: string; count: number }[]; error?: string };
type Day = Calendar["days"][number];

const MONTH = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const LONG_DAY = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

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

function tierCuts(days: Day[]) {
  const busy = days
    .map(d => d.count)
    .filter(n => n > 0)
    .toSorted((a, b) => a - b);
  return [0.2, 0.4, 0.6, 0.8].map(q => busy[Math.floor(q * (busy.length - 1))] ?? 0);
}

function tierOf(n: number, cuts: number[]) {
  if (n === 0) return 0;
  const above = cuts.findIndex(cut => n <= cut);
  return above === -1 ? TIERS : above + 1;
}

const TIERS = 5;
const TIER_FILL = ["var(--viz-neutral)", "var(--viz-cal-1)", "var(--viz-cal-2)", "var(--viz-cal-3)", "var(--viz-cal-4)", "var(--viz-cal-5)"];
const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const isSunday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
const weekdayIndex = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

function weeksFromSunday(days: Day[]) {
  const weeks: Day[][] = [];
  for (const d of days) {
    const week = weeks.at(-1);
    if (week === undefined || isSunday(d.date)) weeks.push([d]);
    else week.push(d);
  }
  return weeks;
}

function monthStarts(weeks: Day[][]) {
  const firstDay = (i: number) => weeks[i]?.[0]?.date ?? "";
  const isNewMonth = (i: number) => i === 0 || firstDay(i).slice(5, 7) !== firstDay(i - 1).slice(5, 7);
  return weeks
    .map((_, i) => i)
    .filter(i => isNewMonth(i) && i < weeks.length - 2)
    .map(i => ({ column: i + 2, label: MONTH.format(new Date(`${firstDay(i)}T12:00:00Z`)) }));
}

function CalendarFacts({ cal, weeks }: { cal: Calendar; weeks: Day[][] }) {
  const best = cal.days.reduce((a, b) => (b.count > a.count ? b : a), cal.days[0] ?? { date: "", count: 0 });
  const thisWeek = weeks.at(-1)?.reduce((n, d) => n + d.count, 0) ?? 0;
  return (
    <div className="-mx-2 grid grid-cols-2 gap-2 sm:flex sm:items-stretch">
      <InnerStat value={thisWeek.toLocaleString()} label="This week" />
      <InnerStat value={`${runEndingTodayOrYesterday(cal.days)} days`} label="Current streak" />
      <InnerStat value={`${longestRun(cal.days)} days`} label="Longest streak" />
      <InnerStat value={best.count > 0 ? `${best.count} · ${short(best.date)}` : "–"} label="Best day" />
    </div>
  );
}

function scrollToToday(scroller: HTMLDivElement | null) {
  scroller?.scrollTo({ left: scroller.scrollWidth });
}

const contributions = (n: number) => (n === 1 ? "1 contribution" : `${n.toLocaleString()} contributions`);

function ContributionCalendar({ cal, onDay }: { cal: Calendar; onDay: (date: string) => void }) {
  const [peek, setPeek] = useState<Peek>();
  const cuts = tierCuts(cal.days);
  const weeks = weeksFromSunday(cal.days);
  const columns = { gridTemplateColumns: `auto repeat(${weeks.length}, var(--cell))` };
  return (
    <Tile label="Contributions in the last year" value={cal.total.toLocaleString()} peek={peek} delta={<span className="text-[13px] font-medium text-[var(--viz-text-3)]">every repo, private ones counted as GitHub does</span>}>
      <CalendarFacts cal={cal} weeks={weeks} />
      <div className="-mt-2 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-[var(--viz-text-2)]">Activity</p>
          <p className="text-[13px] font-medium text-[var(--viz-text-3)]">Click a day to see its week below</p>
        </div>
        <div ref={scrollToToday} className="overflow-x-auto pb-1 [--cell:13px] lg:overflow-visible lg:[--cell:minmax(0,1fr)]" onMouseLeave={() => setPeek(undefined)}>
          <div className="grid w-max grid-rows-[repeat(7,auto)_auto] gap-1 lg:w-full" style={columns}>
            {WEEKDAY_LABELS.map((d, i) => (
              <span key={i} className="flex items-center pe-1 text-xs leading-none font-medium text-[var(--viz-text-3)]" style={{ gridColumn: 1, gridRow: i + 1 }}>
                {d}
              </span>
            ))}
            {weeks.flatMap((w, i) =>
              w.map(d => (
                <button
                  key={d.date}
                  type="button"
                  data-tier={tierOf(d.count, cuts)}
                  aria-label={`${contributions(d.count)} on ${LONG_DAY(d.date)}`}
                  title={`${contributions(d.count)} on ${LONG_DAY(d.date)}`}
                  onClick={() => onDay(d.date)}
                  onMouseEnter={() => setPeek({ value: d.count.toLocaleString(), label: LONG_DAY(d.date) })}
                  className="aspect-square w-full cursor-pointer rounded-[3px] outline-none hover:ring-2 hover:ring-[var(--viz-cursor)] focus-visible:ring-2 focus-visible:ring-[var(--viz-cursor)]"
                  style={{ background: TIER_FILL[tierOf(d.count, cuts)], gridColumn: i + 2, gridRow: weekdayIndex(d.date) + 1 }}
                />
              )),
            )}
            {monthStarts(weeks).map(m => (
              <span key={m.column} className="pt-1 text-[13px] leading-none font-medium whitespace-nowrap text-[var(--viz-text-3)]" style={{ gridColumn: m.column, gridRow: 8 }}>
                {m.label}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 text-xs font-medium text-[var(--viz-text-3)]">
          <span>Less</span>
          {TIER_FILL.map(fill => (
            <span key={fill} className="size-3 rounded-[3px]" style={{ background: fill }} />
          ))}
          <span>More</span>
        </div>
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
            <p className={cn("mt-2 text-xs", hasText(cal.error) || hasText(cal.value?.error) ? "text-rose-600 dark:text-rose-400" : "text-[var(--viz-text-2)]")}>
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
