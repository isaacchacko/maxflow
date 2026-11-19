import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { liveStore } from "@/store";
import { cn } from "@/lib/utils";
import { Agents } from "./stats/Agents";
import { useJson } from "./stats/load";
import { Overview } from "./stats/Overview";
import { addDays, short, type Stats } from "./stats/parts";
import { Performance } from "./stats/Performance";

// yarn's statistics, opened from the mark at the top of the sidebar, in three tabs kept in the URL (#stats/overview,
// #stats/performance, #stats/agents): how productive he has been, how fast and steady yarn runs, and what his agents cost.
// The server counts everything (stats.ts, usage.ts); GitHub's numbers and the transcripts' sums are cached there.

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "performance", label: "Performance" },
  { id: "agents", label: "Agents" },
] as const;
type Tab = (typeof TABS)[number]["id"];

// The repo and the Agents range he picked last are kept in this browser; no repo means the server's default, Dryft-AI/app.
const saved = (key: string) => {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

export function StatsView({ tab: wanted }: { tab?: string }) {
  const tab: Tab = TABS.find(t => t.id === wanted)?.id ?? "overview";
  const [weekKey, setWeekKey] = useState<string>();
  const [repo, setRepo] = useState(() => saved("stats-repo"));
  const [days, setDays] = useState(() => Number(saved("stats-days")) || 7);
  const live = liveStore.use();
  const query = new URLSearchParams({ ...(weekKey && { week: weekKey }), ...(repo && { repo }) });
  // Earlier weeks of the GitHub trend fill in on the server one at a time; look again until they're all there.
  const week = useJson<Stats>(live && tab !== "agents" ? `/api/stats?${query}` : undefined, s => s.gh.trend.pending);
  // A new week or repo keeps the last one on screen, dimmed, until its numbers come in.
  const last = useRef<Stats>(undefined);
  if (week.value) last.current = week.value;
  const stats = week.value ?? last.current;
  const stale = tab !== "agents" && !week.value && !!stats;

  const key = stats?.week.key ?? weekKey;
  const thisWeek = !weekKey || (!!stats && stats.week.to > Date.now());
  const step = (n: number) => key && setWeekKey(addDays(key, 7 * n));
  const pickRepo = (r: string) => (setRepo(r), save("stats-repo", r));
  const pickDays = (n: number) => (setDays(n), save("stats-days", String(n)));
  // The week a day falls in is keyed by any of its days.
  const goWeek = (day: string) => setWeekKey(day);

  return (
    <div className="viz flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
        <h1 className="text-sm font-medium">Stats</h1>
        <nav className="flex rounded-lg bg-[var(--viz-track)] p-0.5 text-xs">
          {TABS.map(t => (
            <a key={t.id} href={`#stats/${t.id}`} className={cn("rounded-md px-2.5 py-0.5", tab === t.id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {t.label}
            </a>
          ))}
        </nav>
        {tab !== "agents" && (
          <div className="ml-auto flex items-center gap-1">
            {!thisWeek && (
              <button onClick={() => setWeekKey(undefined)} className="mr-1 text-xs text-muted-foreground hover:text-foreground">
                This week
              </button>
            )}
            <button onClick={() => step(-1)} disabled={!key} title="Week before" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-36 text-center text-sm tabular-nums">{key ? `${short(key)} – ${short(addDays(key, 6))}` : "This week"}</span>
            <button onClick={() => step(1)} disabled={!key || thisWeek} title="Week after" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex max-w-6xl flex-col gap-8 px-5 py-5", stale && "opacity-60 transition-opacity")}>
          {tab === "agents" ? (
            <Agents live={live} days={days} onDays={pickDays} />
          ) : week.error && !stats ? (
            <p className="text-sm text-rose-600 dark:text-rose-400">Couldn't load stats: {week.error}</p>
          ) : !stats ? (
            <p className="text-sm text-muted-foreground">Counting…</p>
          ) : tab === "performance" ? (
            <Performance stats={stats} live={live} />
          ) : (
            <Overview stats={stats} picked={repo} onRepo={pickRepo} onWeek={goWeek} live={live} />
          )}
        </div>
      </div>
    </div>
  );
}
