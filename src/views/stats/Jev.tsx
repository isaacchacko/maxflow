import { useState } from "react";
import { cn, hasText } from "@/lib/utils";
import { useJson } from "./load";
import { Stages } from "./charts";
import { Columns, SectionHead, Tile, duration, short, weekday, type Peek } from "./parts";

type Pick = { id: string; title: string };
type JevStats = {
  at: number;
  days: string[];
  since?: number;
  model?: string;
  prompt?: string;
  pricePerInputMtok: number;
  confidentAt: number;
  daily: { day: string; calls: number; errors: number; limited: number }[];
  totals: { calls: number; answered: number; errors: number; limited: number; timeouts: number; input: number; output: number; tokensEstimated: boolean; dollars: number; p50?: number; p90?: number };
  quality: { scored: number; agrees: number; funnelAgrees: number; corrected: number; confident: number; confidentRight: number };
  disagreements: { seq: number; at: number; thread?: { id: string; title: string }; jev: Pick; settled: Pick; funnel: Pick; confidence: number }[];
};

function money(n: number) {
  return n >= 10 ? `$${Math.round(n)}` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function count(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
}

const percent = (fraction: number | undefined) => (fraction === undefined ? "–" : `${Math.round(fraction * 100)}%`);
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Kpis({ d }: { d: JevStats }) {
  const t = d.totals;
  const failed = t.errors + t.limited;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Calls" value={t.calls.toLocaleString()}>
        <div className="mt-1 text-xs text-muted-foreground">{t.answered.toLocaleString()} answered</div>
      </Tile>
      <Tile label="Cost" value={money(t.dollars)} hint={`$${d.pricePerInputMtok} per 1M input tokens, output free`}>
        <div className="mt-1 text-xs text-muted-foreground">
          {t.tokensEstimated ? "≈ " : ""}
          {count(t.input)} tokens in · {count(t.output)} out
        </div>
      </Tile>
      <Tile label="Latency p50" value={duration(t.p50)}>
        <div className="mt-1 text-xs text-muted-foreground">p90 {duration(t.p90)}</div>
      </Tile>
      <Tile label="Failed calls" value={failed.toLocaleString()} delta={failed > 0 ? <span className="text-xs text-muted-foreground">{percent(failed / Math.max(1, t.calls))}</span> : undefined}>
        <div className={cn("mt-1 text-xs", t.limited > 0 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
          {t.limited} rate limited (429) · {t.errors} errors{t.timeouts > 0 ? ` (${t.timeouts} timed out)` : ""}
        </div>
      </Tile>
    </div>
  );
}

function CallsPerDay({ d }: { d: JevStats }) {
  const [peek, setPeek] = useState<Peek>();
  const labelOf = (i: number) => {
    const row = d.daily[i];
    if (!row) return "";
    const failed = row.errors + row.limited;
    return `${weekday(row.day, "short")} ${short(row.day)}${failed > 0 ? ` · ${failed} failed (${row.limited} 429)` : ""}`;
  };
  return (
    <Tile label="Calls per day" value={d.totals.calls.toLocaleString()} delta={<span className="text-xs text-muted-foreground">in {d.days.length} days</span>} peek={peek}>
      <Columns
        values={d.daily.map(r => r.calls)}
        labels={d.daily.map((_, i) => labelOf(i))}
        ticks={d.days.map(day => short(day))}
        strong={i => i === d.days.length - 1}
        format={v => `${v.toLocaleString()} calls`}
        onPeek={setPeek}
      />
    </Tile>
  );
}

function Quality({ d }: { d: JevStats }) {
  const q = d.quality;
  return (
    <Tile
      label="Shadow quality"
      value={percent(q.agrees / Math.max(1, q.scored))}
      delta={<span className="text-xs text-muted-foreground">agree · {percent(q.confidentRight / Math.max(1, q.confident))} right when confident</span>}
      hint={`Against where each signal settled: the funnel's pick, corrected by later moves and merges of its thread (${q.corrected} so far). Confident means ≥ ${d.confidentAt}.`}
    >
      <Stages
        stages={[
          { label: "Scored", value: q.scored },
          { label: "Jev agrees", value: q.agrees },
          { label: "Funnel agrees", value: q.funnelAgrees },
          { label: "Confident", value: q.confident },
          { label: "Confident, right", value: q.confidentRight },
        ]}
      />
    </Tile>
  );
}

function Disagreements({ d }: { d: JevStats }) {
  return (
    <Tile label="Recent disagreements" value={d.disagreements.length.toLocaleString()} delta={<span className="text-xs text-muted-foreground">Jev's pick vs where the signal settled</span>}>
      {d.disagreements.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">None in this range.</p>
      ) : (
        <ol className="mt-3 flex flex-col gap-1.5">
          {d.disagreements.map(x => (
            <li key={x.seq} className="grid grid-cols-[7.5rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_2.5rem] items-baseline gap-2 text-xs">
              <span className="text-muted-foreground tabular-nums">{when(x.at)}</span>
              {x.thread ? (
                <a href={`#thread/${x.thread.id}`} className="truncate hover:underline" title={x.thread.title}>
                  {x.thread.title}
                </a>
              ) : (
                <span className="truncate text-muted-foreground">signal {x.seq}</span>
              )}
              <span className="truncate" title={`Jev: ${x.jev.title}`}>
                <span className="text-muted-foreground">Jev </span>
                {x.jev.title}
              </span>
              <span className="truncate" title={`Settled: ${x.settled.title}${x.funnel.id === x.settled.id ? "" : ` (funnel picked ${x.funnel.title})`}`}>
                <span className="text-muted-foreground">→ </span>
                {x.settled.title}
              </span>
              <span className="text-right text-muted-foreground tabular-nums">{x.confidence.toFixed(2)}</span>
            </li>
          ))}
        </ol>
      )}
    </Tile>
  );
}

export function Jev({ days }: { days: number }) {
  const data = useJson<JevStats>(`/api/stats/jev?days=${days}`);
  const d = data.value;
  return (
    <section>
      <SectionHead title="Jev">
        <span className="text-xs text-muted-foreground">
          shadowing the funnel{d?.model === undefined ? "" : ` · ${d.model}`}
          {d?.since === undefined ? "" : ` · logged since ${new Date(d.since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
        </span>
      </SectionHead>
      {!d ? (
        <p className={cn("text-sm", hasText(data.error) ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>{data.error ?? "Reading Jev's log…"}</p>
      ) : d.since === undefined ? (
        <p className="text-sm text-muted-foreground">Jev hasn't been asked anything yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Kpis d={d} />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <CallsPerDay d={d} />
            <Quality d={d} />
          </div>
          <Disagreements d={d} />
        </div>
      )}
    </section>
  );
}
