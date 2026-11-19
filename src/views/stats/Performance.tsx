import { useState } from "react";
import { cn, hasText } from "@/lib/utils";
import { useJson } from "./load";
import { Distributions } from "./charts";
import { Columns, SectionHead, Tile, duration, short, sum, weekday, type Peek, type Stats } from "./parts";
import { LatencyTiles, YarnNote } from "./sections";

type Health = {
  days: string[];
  server: { upSince: number; rssMb: number; starts: number[]; logSince?: number };
  deploys: { at: number; sha: string; subject: string }[];
  sentries: { name: string; running: boolean; upSince: number; respawns: number }[];
  sessions: { total: number; working: number; idle: number; asleep: number; shells: number };
  events: number[];
  ramKills: number[];
  resyncs: number[];
};

const since = (at: number) => duration(Date.now() - at);
const when = (at: number) => new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

function Segments({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = Math.max(1, sum(parts.map(p => p.value)));
  return (
    <div className="mt-4">
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full">
        {parts.filter(p => p.value > 0).map(p => (
          <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${p.value}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
    <Tile label={label} hint={hint} value={sum(values).toLocaleString()} delta={<span className="text-xs text-muted-foreground">in {days.length} days</span>} peek={peek}>
      <Columns
        values={values}
        labels={days.map(d => `${label} · ${weekday(d, "short")} ${short(d)}`)}
        ticks={days.map(d => short(d))}
        strong={i => i === days.length - 1}
        height="h-14"
        format={v => `${v.toLocaleString()} ${unit}`}
        onPeek={setPeek}
      />
    </Tile>
  );
}

function HealthSection({ h }: { h: Health }) {
  const up = h.sentries.filter(s => s.running).length;
  const deploysPerDay = h.days.map(d => h.deploys.filter(x => new Date(x.at).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) === d).length);
  return (
    <section>
      <SectionHead title="Server health">
        <span className="text-xs text-muted-foreground">last {h.days.length} days, as far back as the event log goes</span>
      </SectionHead>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Server up for" value={since(h.server.upSince)} delta={<span className="text-xs text-muted-foreground">{h.server.rssMb} MB</span>}>
            <div className="mt-2 text-xs text-muted-foreground">
              since {when(h.server.upSince)}
              {h.server.logSince === undefined ? " · restarts are logged from this deploy on" : ` · ${h.server.starts.length} restarts logged`}
            </div>
          </Tile>
          <Tile label="Sentries running" value={`${up} of ${h.sentries.length}`} delta={up < h.sentries.length ? <span className="rounded-md bg-rose-500/15 px-1.5 py-px text-xs font-medium text-rose-700 dark:text-rose-300">down: {h.sentries.filter(s => !s.running).map(s => s.name.slice(7)).join(", ")}</span> : <span className="rounded-md bg-emerald-500/15 px-1.5 py-px text-xs font-medium text-emerald-700 dark:text-emerald-300">all up</span>}>
            <div className="mt-2 text-xs text-muted-foreground">{sum(h.sentries.map(s => s.respawns))} restarts after a crash this week</div>
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
          <Tile label="Deploys" value={h.deploys.length.toLocaleString()} delta={<span className="text-xs text-muted-foreground">in 14 days</span>} className="lg:col-span-3">
            <Columns values={deploysPerDay} labels={h.days.map(d => `Deploys · ${weekday(d, "short")} ${short(d)}`)} ticks={h.days.map(d => short(d))} strong={i => i === h.days.length - 1} height="h-12" />
            <ol className="mt-4 flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
              {h.deploys.slice(0, 30).map(d => (
                <li key={`${d.at}${d.sha}`} className="grid grid-cols-[6.5rem_3.5rem_minmax(0,1fr)] items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground tabular-nums">{when(d.at)}</span>
                  <code className="text-muted-foreground">{d.sha}</code>
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
                  <span className="text-right text-muted-foreground tabular-nums" title={`up since ${when(s.upSince)}`}>
                    {s.running ? `up ${since(s.upSince)}` : "–"}
                  </span>
                  <span className={cn("text-right tabular-nums", s.respawns > 0 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{s.respawns > 0 ? `${s.respawns} restart${s.respawns > 1 ? "s" : ""}` : "steady"}</span>
                </li>
              ))}
            </ul>
          </Tile>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <DailyTile label="Bus events" values={h.events} days={h.days} unit="events" hint="Everything published on yarn's event bus" />
          <DailyTile label="Jobs killed for RAM" values={h.ramKills} days={h.days} unit="kills" hint="Local tests or builds the ram sentry stopped" />
          <DailyTile label="Agent state resyncs" values={h.resyncs} days={h.days} unit="resyncs" hint="Times the server found an agent's state out of step with its pane" />
        </div>
      </div>
    </section>
  );
}

export function Performance({ stats, live }: { stats: Stats; live: boolean }) {
  const health = useJson<Health>(live ? "/api/stats/health" : undefined);
  return (
    <>
      <section>
        <SectionHead title="How long each step takes">
          <YarnNote stats={stats} />
        </SectionHead>
        <div className="flex flex-col gap-3">
          <Tile label="Every sample this week on one log axis" value="">
            <Distributions latencies={stats.yarn.latencies} before={stats.yarnBefore} />
          </Tile>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <LatencyTiles stats={stats} />
          </div>
        </div>
      </section>
      {health.value ? (
        <HealthSection h={health.value} />
      ) : (
        <p className={cn("text-sm", hasText(health.error) ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>{health.error ?? "Checking the server…"}</p>
      )}
    </>
  );
}
