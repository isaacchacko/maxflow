import { useState } from "react";
import { cn } from "@/lib/utils";
import { useJson } from "./load";
import { CountTiles, GhNote, GhTrendTiles, RepoPicker, RhythmTile, SectionHead, ThroughputTile, Tile, YarnNote, short, type Peek, type Stats } from "./parts";

// How productive he has been: his GitHub year as his profile draws it, the picked week's GitHub counts against the twelve before
// it, and what yarn turned out that week.

type Calendar = { at: number; total: number; days: { date: string; count: number }[]; error?: string };

const MONTH = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const LONG_DAY = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Runs of days with at least one contribution: the longest, and the one reaching today (or yesterday, before today's first). */
function streaks(days: Calendar["days"]) {
  let longest = 0, run = 0;
  for (const d of days) longest = Math.max(longest, (run = d.count ? run + 1 : 0));
  let current = 0;
  const end = days.length - (days.at(-1)?.count ? 1 : 2);
  for (let i = end; i >= 0 && days[i]!.count; i--) current++;
  return { longest, current };
}

/** GitHub's contribution grid: a column per week, Sunday on top, five shades by quartile of the year's busy days. */
function ContributionCalendar({ cal, onDay }: { cal: Calendar; onDay(date: string): void }) {
  const [peek, setPeek] = useState<Peek>();
  const busy = cal.days.map(d => d.count).filter(Boolean).sort((a, b) => a - b);
  const cut = [0.25, 0.5, 0.75].map(q => busy[Math.floor(q * (busy.length - 1))] ?? 0);
  const level = (n: number) => (!n ? 0 : n <= cut[0]! ? 1 : n <= cut[1]! ? 2 : n <= cut[2]! ? 3 : 4);
  const shade = (l: number) => (l ? `color-mix(in oklab, var(--viz) ${[0, 30, 55, 78, 100][l]}%, var(--viz-track))` : "var(--viz-track)");
  // The grid starts on the Sunday of the first week GitHub sent.
  const weeks: Calendar["days"][] = [];
  for (const d of cal.days) {
    if (!weeks.length || new Date(`${d.date}T12:00:00Z`).getUTCDay() === 0) weeks.push([]);
    weeks.at(-1)!.push(d);
  }
  const { longest, current } = streaks(cal.days);
  const best = cal.days.reduce((a, b) => (b.count > a.count ? b : a), cal.days[0] ?? { date: "", count: 0 });
  const thisWeek = weeks.at(-1)?.reduce((n, d) => n + d.count, 0) ?? 0;
  return (
    <Tile
      label="Contributions in the last year"
      value={cal.total.toLocaleString()}
      peek={peek}
      delta={<span className="text-xs text-muted-foreground">every repo, private ones counted as GitHub does</span>}
      aside={
        <dl className="hidden shrink-0 grid-cols-4 gap-5 text-right sm:grid">
          {[
            ["This week", thisWeek.toLocaleString()],
            ["Current streak", `${current}d`],
            ["Longest streak", `${longest}d`],
            ["Best day", best.count ? `${best.count} · ${short(best.date)}` : "–"],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[11px] text-muted-foreground">{k}</dt>
              <dd className="text-sm font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      }
    >
      <div className="mt-4 overflow-x-auto" onMouseLeave={() => setPeek(undefined)}>
        <div className="flex min-w-[42rem] gap-[3px]">
          <div className="mr-1 grid grid-rows-[0.9rem_repeat(7,minmax(0,1fr))] gap-[3px] text-[10px] text-muted-foreground">
            <span />
            {["", "Mon", "", "Wed", "", "Fri", ""].map((d, i) => (
              <span key={i} className="leading-none self-center">
                {d}
              </span>
            ))}
          </div>
          {weeks.map((w, i) => {
            const first = w[0]!.date;
            const newMonth = i === 0 || first.slice(5, 7) !== weeks[i - 1]![0]!.date.slice(5, 7);
            return (
              <div key={first} className="grid flex-1 grid-rows-[0.9rem_repeat(7,minmax(0,1fr))] gap-[3px]">
                <span className="whitespace-nowrap text-[10px] leading-none text-muted-foreground">{newMonth && i < weeks.length - 2 ? MONTH.format(new Date(`${first}T12:00:00Z`)) : ""}</span>
                {/* A first week that starts midweek leaves its earlier days empty. */}
                {Array.from({ length: 7 - w.length }, (_, k) => (i === 0 ? <span key={`pad${k}`} /> : null))}
                {w.map(d => (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() => onDay(d.date)}
                    onMouseEnter={() => setPeek({ value: d.count.toLocaleString(), label: `Contributions · ${LONG_DAY(d.date)}` })}
                    className="aspect-square w-full rounded-[3px] outline-offset-1 hover:outline hover:outline-2 hover:outline-foreground/60"
                    style={{ background: shade(level(d.count)) }}
                    title={`${d.count} on ${LONG_DAY(d.date)}`}
                  />
                ))}
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>Click a day to see its week below</span>
          <span className="flex items-center gap-1">
            Less
            {[0, 1, 2, 3, 4].map(l => (
              <span key={l} className="size-2.5 rounded-[3px]" style={{ background: shade(l) }} />
            ))}
            More
          </span>
        </div>
      </div>
    </Tile>
  );
}

export function Overview({ stats, picked, onRepo, onWeek, live }: { stats: Stats; picked?: string; onRepo(r: string): void; onWeek(k: string): void; live: boolean }) {
  const cal = useJson<Calendar>(live ? "/api/stats/calendar" : undefined);
  return (
    <>
      <section>
        {cal.value?.days.length ? (
          <ContributionCalendar cal={cal.value} onDay={onWeek} />
        ) : (
          <Tile label="Contributions in the last year" value={cal.error ? "–" : "…"}>
            <p className={cn("mt-2 text-xs", cal.error || cal.value?.error ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
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
