import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { FitLabel, FitRow } from "@/components/Fit";
import { useNow } from "@/lib/effects";
import { liveStore } from "@/store";
import { cn, hasText } from "@/lib/utils";
import { Agents } from "./stats/Agents";
import { useJson } from "./stats/load";
import { Overview } from "./stats/Overview";
import { addDays, short, type Stats } from "./stats/parts";
import { Performance } from "./stats/Performance";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "performance", label: "Performance", short: "Perf" },
  { id: "agents", label: "Agents" },
] as const;

const HOUR_MS = 3_600_000;
const DEFAULT_DAYS = 7;

function savedInThisBrowser(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveInThisBrowser(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // constraint: localStorage throws in a private window or on a full quota; the pick then lasts only this page load
  }
}

function savedDays() {
  const days = Number(savedInThisBrowser("stats-days"));
  return days === 0 || Number.isNaN(days) ? DEFAULT_DAYS : days;
}

function statsQuery(weekKey: string | undefined, repo: string | undefined) {
  const query = new URLSearchParams();
  if (hasText(weekKey)) query.set("week", weekKey);
  if (hasText(repo)) query.set("repo", repo);
  return query;
}

const isTrendStillFilling = (s: Stats) => s.gh.trend.pending;

function WeekRange({ from }: { from: string }) {
  const range = `${short(from)} – ${short(addDays(from, 6))}`;
  return (
    <span title={range}>
      <FitLabel full={range} glyph={short(from)} />
    </span>
  );
}

function WeekNav({ weekKey, isThisWeek, onWeekKey }: { weekKey: string | undefined; isThisWeek: boolean; onWeekKey: (key: string | undefined) => void }) {
  const step = (n: number) => {
    if (hasText(weekKey)) onWeekKey(addDays(weekKey, 7 * n));
  };
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {!isThisWeek && (
        <button onClick={() => onWeekKey(undefined)} title="Back to this week" className="mr-1 text-xs text-muted-foreground hover:text-foreground">
          <FitLabel full="This week" short="Now" />
        </button>
      )}
      <button onClick={() => step(-1)} disabled={!hasText(weekKey)} title="Week before" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
        <ChevronLeft className="size-4" />
      </button>
      <span className="text-center text-sm whitespace-nowrap tabular-nums group-data-[fit=full]/fit:min-w-36 group-data-[fit=short]/fit:min-w-36">{hasText(weekKey) ? <WeekRange from={weekKey} /> : "This week"}</span>
      <button onClick={() => step(1)} disabled={!hasText(weekKey) || isThisWeek} title="Week after" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

type WeekBodyProps = {
  tab: string;
  stats: Stats | undefined;
  error: string | undefined;
  isLive: boolean;
  repo: string | undefined;
  onRepo: (r: string) => void;
  onWeek: (day: string) => void;
};

function WeekBody({ tab, stats, error, isLive, repo, onRepo, onWeek }: WeekBodyProps) {
  if (!stats && hasText(error)) return <p className="text-sm text-rose-600 dark:text-rose-400">Couldn't load stats: {error}</p>;
  if (!stats) return <p className="text-sm text-muted-foreground">Counting…</p>;
  if (tab === "performance") return <Performance stats={stats} live={isLive} />;
  return <Overview stats={stats} picked={repo} onRepo={onRepo} onWeek={onWeek} live={isLive} />;
}

function useWeekStats(isWeekTab: boolean, isLive: boolean, query: URLSearchParams) {
  const week = useJson<Stats>(isLive && isWeekTab ? `/api/stats?${query}` : undefined, isTrendStillFilling);
  const [lastShown, setLastShown] = useState<Stats>();
  if (week.value !== undefined && week.value !== lastShown) setLastShown(week.value);
  const stats = week.value ?? lastShown;
  const isDimmedUntilNewNumbers = isWeekTab && week.value === undefined && stats !== undefined;
  return { stats, error: week.error, isDimmedUntilNewNumbers };
}

export function StatsView({ tab: wanted }: { tab?: string }) {
  const tab = TABS.find(t => t.id === wanted)?.id ?? "overview";
  const [weekKey, setWeekKey] = useState<string>();
  const [repo, setRepo] = useState(() => savedInThisBrowser("stats-repo") ?? undefined);
  const [days, setDays] = useState(savedDays);
  const isLive = liveStore.use();
  const { stats, error, isDimmedUntilNewNumbers } = useWeekStats(tab !== "agents", isLive, statsQuery(weekKey, repo));
  const now = useNow(at => (stats && stats.week.to > at ? Math.min(HOUR_MS, stats.week.to - at) : HOUR_MS));

  const key = stats?.week.key ?? weekKey;
  const isThisWeek = !hasText(weekKey) || (stats !== undefined && stats.week.to > now);
  const pickRepo = (r: string) => {
    setRepo(r);
    saveInThisBrowser("stats-repo", r);
  };
  const pickDays = (n: number) => {
    setDays(n);
    saveInThisBrowser("stats-days", String(n));
  };
  const goToWeekContaining = (day: string) => setWeekKey(day);

  return (
    <div className="viz flex h-full flex-col">
      <FitRow className="h-12 shrink-0 items-center gap-3 border-b px-5 data-[fit=glyph]:gap-2 data-[fit=glyph]:px-3">
        <h1 className="shrink-0 text-sm font-medium group-data-[fit=glyph]/fit:hidden">Stats</h1>
        <nav className="flex shrink-0 rounded-lg bg-[var(--viz-track)] p-0.5 text-xs">
          {TABS.map(t => (
            <a key={t.id} href={`#stats/${t.id}`} title={t.label} className={cn("rounded-md px-2.5 py-0.5", tab === t.id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              <FitLabel full={t.label} short={"short" in t ? t.short : undefined} />
            </a>
          ))}
        </nav>
        {tab !== "agents" && <WeekNav weekKey={key} isThisWeek={isThisWeek} onWeekKey={setWeekKey} />}
      </FitRow>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex max-w-6xl flex-col gap-8 px-5 py-5", isDimmedUntilNewNumbers && "opacity-60 transition-opacity")}>
          {tab === "agents" ? (
            <Agents live={isLive} days={days} onDays={pickDays} />
          ) : (
            <WeekBody tab={tab} stats={stats} error={error} isLive={isLive} repo={repo} onRepo={pickRepo} onWeek={goToWeekContaining} />
          )}
        </div>
      </div>
    </div>
  );
}
