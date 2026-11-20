import { useState } from "react";
import { cn, hasText } from "@/lib/utils";
import { useJson } from "./load";
import { Distributions } from "./charts";
import { Columns, SectionHead, SkeletonTile, SkeletonTiles, Tile, duration, short, sum, weekday, type Peek, type Stats } from "./parts";
import { ResourcesSection } from "./Resources";
import { LatencyTiles, YarnNote } from "./sections";

type Budget = { used: number; limit: number; remaining: number; reset: number };
type RateSample = { at: number; core: Budget; graphql: Budget };

type Health = {
  days: string[];
  server: { upSince: number; rssMb: number; starts: number[]; logSince?: number };
  deploys: { at: number; sha: string; subject: string }[];
  sentries: { name: string; running: boolean; upSince: number; respawns: number }[];
  sessions: { total: number; working: number; idle: number; asleep: number; shells: number };
  events: number[];
  ramKills: number[];
  resyncs: number[];
  sleptWithWorkOpen: number[];
  github: RateSample[];
};

const since = (at: number) => duration(Date.now() - at);
const when = (at: number) => new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

function Segments({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = Math.max(1, sum(parts.map(p => p.value)));
  return (
    <div className="mt-4">
      <div className="flex h-5 gap-[3px] overflow-hidden rounded-full bg-[var(--viz-track)]">
        {parts.filter(p => p.value > 0).map(p => (
          <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${p.value}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--viz-text-2)]">
        {parts.map(p => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: p.color }} />
            {p.label} <span className="text-foreground tabular-nums">{p.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function DailyTile({ label, values, days, hint, unit }: { label: string; values: number[]; days: string[]; hint?: string; unit: string }) {
  const [peek, setPeek] = useState<Peek>();
  return (
    <Tile label={label} hint={hint} value={sum(values).toLocaleString()} delta={<span className="text-xs text-[var(--viz-text-2)]">in {days.length} days</span>} peek={peek}>
      <Columns
        values={values}
        labels={days.map(d => `${label} · ${weekday(d, "short")} ${short(d)}`)}
        ticks={days.map(d => short(d))}
        strong={i => i === days.length - 1}
        format={v => `${v.toLocaleString()} ${unit}`}
        onPeek={setPeek}
      />
    </Tile>
  );
}

const LOW = 0.2;
const BUCKET_MS = 5 * 60_000;
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function spentPerBucket(samples: RateSample[], key: "core" | "graphql") {
  const first = samples[0];
  if (!first) return [];
  const buckets = Array.from({ length: Math.floor((Date.now() - first.at) / BUCKET_MS) + 1 }, () => 0);
  for (const [i, s] of samples.entries()) {
    const prev = samples[i - 1];
    if (!prev) continue;
    const spent = s[key].reset === prev[key].reset ? Math.max(0, s[key].used - prev[key].used) : s[key].used;
    const at = Math.floor((s.at - first.at) / BUCKET_MS);
    buckets[at] = (buckets[at] ?? 0) + spent;
  }
  return buckets;
}

function BudgetMeter({ label, b }: { label: string; b: Budget }) {
  const left = b.remaining / Math.max(1, b.limit);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-[var(--viz-text-2)]">{label}</span>
        <span className="tabular-nums">
          <span className={cn("font-medium", left < LOW && "text-rose-700 dark:text-rose-300")}>{b.remaining.toLocaleString()}</span>
          <span className="text-[var(--viz-text-2)]"> of {b.limit.toLocaleString()} · resets {clock(b.reset)}</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--viz-track)]">
        <div className={cn("h-full rounded-full", left < LOW ? "bg-rose-500" : "bg-[var(--viz)]")} style={{ width: `${left * 100}%` }} />
      </div>
    </div>
  );
}

function GitHubBudget({ samples }: { samples: RateSample[] }) {
  const [peek, setPeek] = useState<Peek>();
  const last = samples.at(-1);
  if (!last) return null;
  const left = Math.min(last.core.remaining / Math.max(1, last.core.limit), last.graphql.remaining / Math.max(1, last.graphql.limit));
  const spent = spentPerBucket(samples, "core");
  const start = samples[0]?.at ?? last.at;
  return (
    <Tile
      label="GitHub API left"
      hint="Isaac's hourly budget, shared by every agent, sentry and his own work; sampled by the gh sentry every poll"
      value={`${Math.round(left * 100)}%`}
      delta={left < LOW ? <span className="rounded-md bg-rose-500/15 px-1.5 py-px text-xs font-medium text-rose-700 dark:text-rose-300">low</span> : <span className="text-xs text-[var(--viz-text-2)]">as of {clock(last.at)}</span>}
      peek={peek}
    >
      <div className="flex flex-col gap-3">
        <BudgetMeter label="REST (gh run, gh api)" b={last.core} />
        <BudgetMeter label="GraphQL (sentries, gh pr)" b={last.graphql} />
      </div>
      {spent.length > 1 && (
        <Columns
          values={spent}
          labels={spent.map((_, i) => `REST calls · ${clock(start + i * BUCKET_MS)}`)}
          ticks={spent.map((_, i) => clock(start + i * BUCKET_MS))}
          strong={i => i === spent.length - 1}
          format={v => `${v.toLocaleString()} calls`}
          onPeek={setPeek}
          height="h-20"
        />
      )}
    </Tile>
  );
}

function HealthSection({ h }: { h: Health }) {
  const up = h.sentries.filter(s => s.running).length;
  const deploysPerDay = h.days.map(d => h.deploys.filter(x => new Date(x.at).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) === d).length);
  return (
    <section>
      <SectionHead title="Server health">
        <span className="text-xs text-[var(--viz-text-2)]">last {h.days.length} days, as far back as the event log goes</span>
      </SectionHead>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Server up for" value={since(h.server.upSince)} delta={<span className="text-xs text-[var(--viz-text-2)]">{h.server.rssMb} MB</span>}>
            <div className="mt-2 text-xs text-[var(--viz-text-2)]">
              since {when(h.server.upSince)}
              {h.server.logSince === undefined ? " · restarts are logged from this deploy on" : ` · ${h.server.starts.length} restarts logged`}
            </div>
          </Tile>
          <Tile label="Sentries running" value={`${up} of ${h.sentries.length}`} delta={up < h.sentries.length ? <span className="rounded-md bg-rose-500/15 px-1.5 py-px text-xs font-medium text-rose-700 dark:text-rose-300">down: {h.sentries.filter(s => !s.running).map(s => s.name.slice(7)).join(", ")}</span> : <span className="rounded-md bg-emerald-500/15 px-1.5 py-px text-xs font-medium text-emerald-700 dark:text-emerald-300">all up</span>}>
            <div className="mt-2 text-xs text-[var(--viz-text-2)]">{sum(h.sentries.map(s => s.respawns))} restarts after a crash this week</div>
          </Tile>
          <Tile label="Sessions" value={h.sessions.total.toLocaleString()} className="sm:col-span-2">
            <Segments
              parts={[
                { label: "Working", value: h.sessions.working, color: "var(--viz)" },
                { label: "Idle", value: h.sessions.idle, color: "color-mix(in oklab, var(--viz) 55%, var(--viz-track))" },
                { label: "Asleep", value: h.sessions.asleep, color: "color-mix(in oklab, var(--muted-foreground) 45%, var(--viz-track))" },
                { label: "Shells", value: h.sessions.shells, color: "color-mix(in oklab, var(--muted-foreground) 25%, var(--viz-track))" },
              ]}
            />
          </Tile>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
          <Tile label="Deploys" value={h.deploys.length.toLocaleString()} delta={<span className="text-xs text-[var(--viz-text-2)]">in 14 days</span>} className="lg:col-span-3">
            <Columns values={deploysPerDay} labels={h.days.map(d => `Deploys · ${weekday(d, "short")} ${short(d)}`)} ticks={h.days.map(d => short(d))} strong={i => i === h.days.length - 1} height="h-24" />
            <ol className="mt-4 flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
              {h.deploys.slice(0, 30).map(d => (
                <li key={`${d.at}${d.sha}`} className="grid grid-cols-[6.5rem_3.5rem_minmax(0,1fr)] items-baseline gap-2 text-xs">
                  <span className="text-[var(--viz-text-2)] tabular-nums">{when(d.at)}</span>
                  <code className="text-[var(--viz-text-2)]">{d.sha}</code>
                  <span className="truncate" title={d.subject}>
                    {d.subject}
                  </span>
                </li>
              ))}
            </ol>
          </Tile>
          <Tile label="Sentries" value="" className="lg:col-span-2">
            <ul className="mt-1 flex flex-col gap-1.5">
              {h.sentries.map(s => (
                <li key={s.name} className="grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-2 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={cn("size-1.5 shrink-0 rounded-full", s.running ? "bg-emerald-500" : "bg-rose-500")} />
                    <span className="truncate">{s.name.slice(7)}</span>
                    {!s.running && <span className="text-rose-600 dark:text-rose-400">down</span>}
                  </span>
                  <span className="text-right text-[var(--viz-text-2)] tabular-nums" title={`up since ${when(s.upSince)}`}>
                    {s.running ? `up ${since(s.upSince)}` : "–"}
                  </span>
                  <span className={cn("text-right tabular-nums", s.respawns > 0 ? "text-amber-700 dark:text-amber-300" : "text-[var(--viz-text-2)]")}>{s.respawns > 0 ? `${s.respawns} restart${s.respawns > 1 ? "s" : ""}` : "steady"}</span>
                </li>
              ))}
            </ul>
          </Tile>
        </div>
        <GitHubBudget samples={h.github} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <DailyTile label="Bus events" values={h.events} days={h.days} unit="events" hint="Everything published on yarn's event bus" />
          <DailyTile label="Jobs killed for RAM" values={h.ramKills} days={h.days} unit="kills" hint="Local tests or builds the ram sentry stopped" />
          <DailyTile label="Agent state resyncs" values={h.resyncs} days={h.days} unit="resyncs" hint="Times the server found an agent's state out of step with its pane" />
          <DailyTile label="Agents asleep with work open" values={h.sleptWithWorkOpen} days={h.days} unit="agents" hint="Agents put to sleep with your message unanswered or a wait that can never end; each one posted in its thread and told its router" />
        </div>
      </div>
    </section>
  );
}

function HealthSkeleton() {
  return (
    <section>
      <SectionHead title="Server health" />
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SkeletonTiles count={2} chart="h-4" />
          <SkeletonTile chart="h-5" className="sm:col-span-2" />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
          <SkeletonTile chart="h-80" className="lg:col-span-3" />
          <SkeletonTile chart="h-80" className="lg:col-span-2" />
        </div>
      </div>
    </section>
  );
}

function StepsSection({ stats }: { stats: Stats | undefined }) {
  return (
    <section>
      <SectionHead title="How long each step takes">{stats && <YarnNote stats={stats} />}</SectionHead>
      <div className="flex flex-col gap-3">
        {stats ? (
          <Tile label="Every sample this week on one log axis" value="">
            <Distributions latencies={stats.yarn.latencies} before={stats.yarnBefore} />
          </Tile>
        ) : (
          <SkeletonTile chart="h-64" />
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{stats ? <LatencyTiles stats={stats} /> : <SkeletonTiles count={4} />}</div>
      </div>
    </section>
  );
}

export function Performance({ stats, live }: { stats: Stats | undefined; live: boolean }) {
  const health = useJson<Health>(live ? "/api/stats/health" : undefined);
  return (
    <>
      <ResourcesSection live={live} />
      <StepsSection stats={stats} />
      {health.value && <HealthSection h={health.value} />}
      {!health.value && hasText(health.error) && <p className="text-sm text-rose-600 dark:text-rose-400">{health.error}</p>}
      {!health.value && !hasText(health.error) && <HealthSkeleton />}
    </>
  );
}
