import { useState } from "react";
import { hasText } from "@/lib/utils";
import { useJson } from "./load";
import { Columns, InnerStat, SectionHead, Segmented, SkeletonTiles, StageBars, Tile, duration, short, weekday, type Peek } from "./parts";

type Pick = { id: string; title: string };
type JevStats = {
  at: number;
  days: string[];
  since?: number;
  model?: string;
  pricePerInputMtok: number;
  confidentAt: number;
  daily: { day: string; calls: number; errors: number; limited: number }[];
  totals: { calls: number; answered: number; errors: number; limited: number; timeouts: number; input: number; output: number; tokensEstimated: boolean; dollars: number; p50?: number; p90?: number };
  objective: Question;
  size: Question;
};
type Question = {
  prompt?: string;
  quality: { scored: number; agrees: number; funnelAgrees: number; corrected: number; confident: number; confidentRight: number };
  disagreements: { seq: number; at: number; thread?: { id: string; title: string }; jev: Pick; settled: Pick; funnel: Pick; confidence: number }[];
};
type QuestionId = "objective" | "size";

const QUESTIONS: { id: QuestionId; label: string; short: string; settled: string }[] = [
  { id: "objective", label: "Picking the objective", short: "Objective", settled: "the funnel's pick, corrected by later moves and merges of its thread" },
  { id: "size", label: "Sizing the request", short: "Size", settled: "what it turned out to be: a direct worker, promoted to an area router, or an FYI or ignore that Isaac didn't reopen by posting in its thread" },
];

const NOTE = "text-sm text-[var(--viz-text-2)]";
const DOWN_CHIP = "rounded-md bg-[var(--viz-down-bg)] px-1.5 py-px text-xs font-medium text-[var(--viz-down)]";

function money(n: number) {
  if (n >= 10) return `$${Math.round(n)}`;
  return n === 0 || n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function count(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
}

const percent = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`);
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Kpis({ d }: { d: JevStats }) {
  const t = d.totals;
  const failed = t.errors + t.limited;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Calls" value={t.calls.toLocaleString()}>
        <div className={NOTE}>{t.answered.toLocaleString()} answered</div>
      </Tile>
      <Tile label="Cost" value={money(t.dollars)} hint={`$${d.pricePerInputMtok} per 1M input tokens, output free`}>
        <div className={NOTE}>
          {t.tokensEstimated ? "≈ " : ""}
          {count(t.input)} tokens in · {count(t.output)} out
        </div>
      </Tile>
      <Tile label="Latency p50" value={duration(t.p50)}>
        <div className={NOTE}>p90 {duration(t.p90)}</div>
      </Tile>
      <Tile label="Failed calls" value={failed.toLocaleString()} delta={failed > 0 && <span className={DOWN_CHIP}>{percent(failed, t.calls)}</span>}>
        <div className={NOTE}>
          {t.limited} rate limited (429) · {t.errors} errors{t.timeouts > 0 ? ` (${t.timeouts} timed out)` : ""}
        </div>
      </Tile>
    </div>
  );
}

function CallsPerDay({ d }: { d: JevStats }) {
  const [peek, setPeek] = useState<Peek>();
  const labelOf = (row: JevStats["daily"][number]) => {
    const failed = row.errors + row.limited;
    return `${weekday(row.day, "short")} ${short(row.day)}${failed > 0 ? ` · ${failed} failed (${row.limited} 429)` : ""}`;
  };
  return (
    <Tile label="Calls per day" value={d.totals.calls.toLocaleString()} delta={<span className={NOTE}>in {d.days.length} days</span>} peek={peek}>
      <Columns values={d.daily.map(r => r.calls)} labels={d.daily.map(labelOf)} ticks={d.days.map(day => short(day))} strong={i => i === d.days.length - 1} format={v => `${v.toLocaleString()} calls`} onPeek={setPeek} />
    </Tile>
  );
}

function Quality({ q, label, settled, confidentAt }: { q: Question["quality"]; label: string; settled: string; confidentAt: number }) {
  const [peek, setPeek] = useState<Peek>();
  if (q.scored === 0)
    return (
      <Tile label={label} value="–">
        <div className={NOTE}>Nothing scored yet</div>
      </Tile>
    );
  return (
    <Tile label={label} value={percent(q.agrees, q.scored)} delta={<span className={NOTE}>Jev agrees</span>} peek={peek} hint={`Against where each signal settled: ${settled}. Confident means ≥ ${confidentAt}.`}>
      <StageBars
        rows={[
          { key: "scored", label: "Scored", value: q.scored },
          { key: "jev", label: "Jev agrees", value: q.agrees, note: percent(q.agrees, q.scored) },
          { key: "funnel", label: "Funnel agrees", value: q.funnelAgrees, note: percent(q.funnelAgrees, q.scored) },
          { key: "confident", label: "Confident", value: q.confident, note: percent(q.confident, q.scored) },
          { key: "right", label: "Confident, right", value: q.confidentRight, note: percent(q.confidentRight, q.scored) },
        ]}
        top={q.scored}
        onPeek={setPeek}
      />
      <div className="flex gap-2">
        <InnerStat value={percent(q.confidentRight, q.confident)} label="right when confident" />
        <InnerStat value={q.corrected.toLocaleString()} label="funnel corrected" />
      </div>
    </Tile>
  );
}

function Disagreements({ d, question, onQuestion }: { d: JevStats; question: QuestionId; onQuestion: (q: QuestionId) => void }) {
  const list = d[question].disagreements;
  return (
    <Tile
      label="Recent disagreements"
      value={list.length.toLocaleString()}
      delta={<span className={NOTE}>Jev's pick vs where the signal settled</span>}
      aside={<Segmented label="Question" options={QUESTIONS.map(q => ({ id: q.id, label: q.short }))} value={question} onChange={onQuestion} />}
    >
      {list.length === 0 ? (
        <p className={NOTE}>None in this range.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {list.map(x => (
            <li key={x.seq} className="grid grid-cols-[8rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_2.5rem] items-baseline gap-2 text-sm text-[var(--viz-text)]">
              <span className="text-[var(--viz-text-3)] tabular-nums">{when(x.at)}</span>
              {x.thread ? (
                <a href={`#thread/${x.thread.id}`} className="truncate hover:underline" title={x.thread.title}>
                  {x.thread.title}
                </a>
              ) : (
                <span className="truncate text-[var(--viz-text-3)]">signal {x.seq}</span>
              )}
              <span className="truncate" title={`Jev: ${x.jev.title}`}>
                <span className="text-[var(--viz-text-3)]">Jev </span>
                {x.jev.title}
              </span>
              <span className="truncate" title={`Settled: ${x.settled.title}${x.funnel.id === x.settled.id ? "" : ` (funnel picked ${x.funnel.title})`}`}>
                <span className="text-[var(--viz-text-3)]">→ </span>
                {x.settled.title}
              </span>
              <span className="text-right text-[var(--viz-text-3)] tabular-nums">{x.confidence.toFixed(2)}</span>
            </li>
          ))}
        </ol>
      )}
    </Tile>
  );
}

function JevBody({ d, error, question, onQuestion }: { d: JevStats | undefined; error: string | undefined; question: QuestionId; onQuestion: (q: QuestionId) => void }) {
  if (!d && hasText(error)) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!d)
    return (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SkeletonTiles count={4} chart={false} />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <SkeletonTiles count={3} chart="h-28" />
        </div>
      </div>
    );
  if (d.since === undefined) return <p className={NOTE}>Jev hasn't been asked anything yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      <Kpis d={d} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <CallsPerDay d={d} />
        {QUESTIONS.map(q => (
          <Quality key={q.id} q={d[q.id].quality} label={q.label} settled={q.settled} confidentAt={d.confidentAt} />
        ))}
      </div>
      <Disagreements d={d} question={question} onQuestion={onQuestion} />
    </div>
  );
}

export function Jev({ days }: { days: number }) {
  const [question, setQuestion] = useState<QuestionId>("objective");
  const data = useJson<JevStats>(`/api/stats/jev?days=${days}`);
  const d = data.value;
  return (
    <section>
      <SectionHead title="Jev">
        <span className="text-xs text-[var(--viz-text-2)]">
          shadowing the funnel{d?.model === undefined ? "" : ` · ${d.model}`}
          {d?.since === undefined ? "" : ` · logged since ${new Date(d.since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
        </span>
      </SectionHead>
      <JevBody d={d} error={data.error} question={question} onQuestion={setQuestion} />
    </section>
  );
}
