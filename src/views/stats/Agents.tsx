import { useState } from "react";
import { cn, hasText } from "@/lib/utils";
import { Jev } from "./Jev";
import { useJson } from "./load";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AXIS_TICK, Segmented, SectionHead, SkeletonTile, SkeletonTiles, StageBars, Tile, indexOf, short, weekday } from "./parts";

type Group = {
  id: string;
  name: string;
  kind: "agent" | "sentry" | "outside";
  objective?: string;
  role?: string;
  dollars: number;
  saved: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  messages: number;
  activeMs: number;
  first?: number;
  last?: number;
  models: Record<string, number>;
  prs: number;
  threads: number;
};
type AgentStats = {
  at: number;
  scanning: boolean;
  days: string[];
  activeGapMin: number;
  totals: { dollars: number; saved: number; input: number; output: number; cacheRead: number; cacheWrite: number; messages: number; activeMs: number; agents: number; yarnDollars: number; prs: number; threads: number };
  daily: { day: string; models: Record<string, [number, number]> }[];
  models: { model: string; dollars: number; tokens: number }[];
  groups: Group[];
  objectives: { id: string; title: string; dollars: number; agents: number; activeMs: number; prs: number; threads: number }[];
};

const RANGES = [7, 30, 90];
type Measure = "cost" | "tokens";
const MEASURES: Measure[] = ["cost", "tokens"];
type Family = [RegExp, string, string];
type Slice = { label: string; color: string; v: number };

const FAMILIES: Family[] = [
  [/opus/, "Opus", "var(--viz)"],
  [/haiku/, "Haiku", "var(--viz-2)"],
  [/sonnet/, "Sonnet", "var(--viz-3)"],
  [/fable|mythos/, "Fable", "var(--viz-4)"],
];
const ANY_OTHER_FAMILY_IN_GREY: Family = [/./, "Other", "var(--viz-cursor)"];
const family = (model: string) => FAMILIES.find(([re]) => re.test(model)) ?? ANY_OTHER_FAMILY_IN_GREY;
const familyOrder = (label: string) => FAMILIES.findIndex(f => f[1] === label);
const modelName = (model: string) => model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1").replace(/^./, c => c.toUpperCase());

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function money(n: number) {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

function count(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  return n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
}

const tokensOf = (g: Group) => g.tokens.input + g.tokens.output + g.tokens.cacheRead + g.tokens.cacheWrite;
const hours = (ms: number) => (ms >= HOUR_MS ? `${(ms / HOUR_MS).toFixed(ms >= 10 * HOUR_MS ? 0 : 1)}h` : `${Math.round(ms / MINUTE_MS)}m`);
const sumOf = (values: number[]) => values.reduce((a, b) => a + b, 0);

function familyStack(models: Record<string, [number, number]>, at: 0 | 1) {
  const byFamily = new Map<string, Slice>();
  for (const [m, v] of Object.entries(models)) {
    const [, label, color] = family(m);
    const slice = byFamily.get(label) ?? { label, color, v: 0 };
    slice.v += v[at];
    byFamily.set(label, slice);
  }
  return byFamily
    .values()
    .toArray()
    .toSorted((a, b) => familyOrder(a.label) - familyOrder(b.label));
}

function SliceLegend({ slices, fmt }: { slices: Slice[]; fmt: (v: number) => string }) {
  return (
    <span className="flex gap-3 text-[13px] font-medium text-[var(--viz-text-2)]">
      {slices.map(x => (
        <span key={x.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: x.color }} />
          {x.label} <span className="text-[var(--viz-text)] tabular-nums">{fmt(x.v)}</span>
        </span>
      ))}
    </span>
  );
}

function FamiliesOnScreen({ slices }: { slices: Slice[] }) {
  return (
    <dl className="flex shrink-0 items-center gap-4 text-[13px] font-medium text-[var(--viz-text-2)]">
      {slices.map(x => (
        <div key={x.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: x.color }} aria-hidden />
          <dt>{x.label}</dt>
        </div>
      ))}
    </dl>
  );
}

function dayTicks(days: string[]) {
  return new Set(days.length > 14 ? [0, Math.floor(days.length / 2), days.length - 1] : days.map((_, i) => i));
}

const STACK_TOP_RADIUS: [number, number, number, number] = [4, 4, 0, 0];

function Daily({ data, measure }: { data: AgentStats; measure: Measure }) {
  const [hover, setHover] = useState<number>();
  const stacks = data.daily.map(d => familyStack(d.models, measure === "cost" ? 0 : 1));
  const totals = stacks.map(s => sumOf(s.map(x => x.v)));
  const shown = new Map(stacks.flat().map(x => [x.label, x])).values().toArray().toSorted((a, b) => familyOrder(a.label) - familyOrder(b.label));
  const rows = data.days.map((day, i) => ({ day, ...Object.fromEntries((stacks[i] ?? []).map(x => [x.label, x.v])) }));
  const ticks = dayTicks(data.days);
  const fmt = measure === "cost" ? money : count;
  const hoveredDay = hover === undefined ? undefined : data.days[hover];
  const hoveredStack = hover === undefined ? undefined : stacks[hover];
  return (
    <Tile
      label={hoveredDay === undefined ? `${measure === "cost" ? "Cost" : "Tokens"} per day` : `${weekday(hoveredDay, "short")} ${short(hoveredDay)}`}
      value={fmt(hover === undefined ? sumOf(totals) : (totals[hover] ?? 0))}
      delta={hoveredStack && <SliceLegend slices={hoveredStack} fmt={fmt} />}
      aside={<FamiliesOnScreen slices={shown} />}
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 6, bottom: 0, left: 0 }} barCategoryGap="22%" onMouseMove={state => setHover(indexOf(state))} onMouseLeave={() => setHover(undefined)}>
            <YAxis width={44} tickCount={4} tickFormatter={fmt} tickLine={false} axisLine={false} tick={{ ...AXIS_TICK, fontSize: 12 }} />
            <XAxis dataKey="day" interval={0} axisLine={false} tickLine={false} tickMargin={12} tick={AXIS_TICK} tickFormatter={(d: string, i: number) => (ticks.has(i) ? short(d) : "")} />
            <Tooltip content={() => null} cursor={{ fill: "var(--viz-track)", opacity: 0.5 }} />
            {shown.map((x, k) => (
              <Bar key={x.label} dataKey={x.label} stackId="day" fill={x.color} radius={k === shown.length - 1 ? STACK_TOP_RADIUS : 0} isAnimationActive animationDuration={450} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Tile>
  );
}

const KINDS = [
  { id: "agent", label: "yarn agents" },
  { id: "sentry", label: "Sentries" },
  { id: "outside", label: "Outside yarn" },
] as const;

const NONE = <span className="text-[var(--viz-text-2)]">–</span>;
const valueOf = (g: Group, measure: Measure) => (measure === "cost" ? g.dollars : tokensOf(g));

function SpendByModelBar({ g, width }: { g: Group; width: number }) {
  const mix = Object.entries(g.models).toSorted((a, b) => b[1] - a[1]);
  const spent = g.dollars === 0 ? 1 : g.dollars;
  return (
    <span className="flex h-2.5 overflow-hidden rounded-full bg-[var(--viz-track)]" style={{ width: `${width}%` }}>
      {mix.map(([m, d]) => (
        <span key={m} style={{ width: `${(d / spent) * 100}%`, background: family(m)[2] }} title={`${modelName(m)}: ${money(d)}`} />
      ))}
    </span>
  );
}

function AgentRow({ g, measure, top }: { g: Group; measure: Measure; top: number }) {
  const v = valueOf(g, measure);
  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 pr-3">
        {g.kind === "outside" ? (
          <span className="block truncate" title={g.name}>
            {g.name}
          </span>
        ) : (
          <a href={`#agent/${g.id}`} className="block truncate hover:underline" title={`${g.name} (${g.id})`}>
            {g.name}
          </a>
        )}
        {hasText(g.objective) && (
          <span className="block truncate text-[11px] text-[var(--viz-text-2)]">
            {g.role === "router" ? "router · " : ""}
            {g.objective}
          </span>
        )}
      </td>
      <td className="py-1.5 pr-3">
        <div className="flex items-center gap-2">
          <SpendByModelBar g={g} width={Math.max(4, (v / top) * 100)} />
          <span className="shrink-0 tabular-nums">{measure === "cost" ? money(v) : count(v)}</span>
        </div>
      </td>
      <td className="py-1.5 text-right text-[var(--viz-text-2)] tabular-nums">{hours(g.activeMs)}</td>
      <td className="py-1.5 text-right text-[var(--viz-text-2)] tabular-nums">{g.messages.toLocaleString()}</td>
      <td className="py-1.5 text-right tabular-nums">{g.prs > 0 ? g.prs : NONE}</td>
      <td className="py-1.5 text-right tabular-nums">{g.threads > 0 ? g.threads : NONE}</td>
      <td className="py-1.5 text-right tabular-nums">{g.prs > 0 ? money(g.dollars / g.prs) : NONE}</td>
    </tr>
  );
}

function KindPicker({ kind, onKind }: { kind: Group["kind"]; onKind: (kind: Group["kind"]) => void }) {
  return <Segmented label="Kind" options={[...KINDS]} value={kind} onChange={onKind} />;
}

function AgentTable({ data, measure }: { data: AgentStats; measure: Measure }) {
  const [kind, setKind] = useState<Group["kind"]>("agent");
  const [isShowingAll, setShowingAll] = useState(false);
  const rows = data.groups.filter(g => g.kind === kind).toSorted((a, b) => valueOf(b, measure) - valueOf(a, measure));
  const shown = isShowingAll ? rows : rows.slice(0, 15);
  const top = Math.max(1e-9, ...rows.map(g => valueOf(g, measure)));
  const kindLabel = KINDS.find(k => k.id === kind)?.label ?? kind;
  return (
    <Tile label="Most expensive" value={`${rows.length.toLocaleString()} ${kindLabel.toLowerCase()}`} aside={<KindPicker kind={kind} onKind={setKind} />}>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[46rem] table-fixed text-xs">
          <thead className="text-left text-[11px] text-[var(--viz-text-2)]">
            <tr>
              <th className="w-[30%] pb-2 font-normal">{kind === "outside" ? "Folder" : "Agent"}</th>
              <th className="w-[24%] pb-2 font-normal">{measure === "cost" ? "Cost" : "Tokens"}</th>
              <th className="pb-2 text-right font-normal" title={`Time between its messages, gaps over ${data.activeGapMin} minutes left out`}>
                Active
              </th>
              <th className="pb-2 text-right font-normal">Messages</th>
              <th className="pb-2 text-right font-normal">PRs merged</th>
              <th className="pb-2 text-right font-normal">Threads resolved</th>
              <th className="pb-2 text-right font-normal">Per PR</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(g => (
              <AgentRow key={`${g.kind}${g.id}`} g={g} measure={measure} top={top} />
            ))}
          </tbody>
        </table>
        {rows.length > 15 && (
          <button onClick={() => setShowingAll(!isShowingAll)} className="mt-2 text-xs text-[var(--viz-text-2)] hover:text-foreground">
            {isShowingAll ? "Show the top 15" : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </Tile>
  );
}

const perOrNone = (dollars: number, n: number) => (n > 0 ? money(dollars / n) : "–");

function kpisOf(t: AgentStats["totals"], measure: Measure): [string, string, string][] {
  const tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  const isCost = measure === "cost";
  return [
    [isCost ? "Cost at API rates" : "Tokens", isCost ? money(t.dollars) : count(tokens), isCost ? `${money(t.yarnDollars)} in yarn` : `${count(t.output)} written`],
    ["Saved by the cache", money(t.saved), `${Math.round((t.cacheRead / Math.max(1, t.input + t.cacheRead + t.cacheWrite)) * 100)}% of input read from it`],
    ["Agent hours", hours(t.activeMs), `${t.agents} yarn agents · ${t.messages.toLocaleString()} messages`],
    ["Per merged PR", perOrNone(t.yarnDollars, t.prs), `${t.prs} merged · ${perOrNone(t.yarnDollars, t.threads)} per resolved thread`],
  ];
}

function UsageToggles({ measure, onMeasure, days, onDays }: { measure: Measure; onMeasure: (m: Measure) => void; days: number; onDays: (n: number) => void }) {
  return (
    <div className="ml-auto flex gap-2">
      <Segmented label="Measure" options={MEASURES.map(m => ({ id: m, label: m === "cost" ? "Cost" : "Tokens" }))} value={measure} onChange={onMeasure} />
      <Segmented label="Range" options={RANGES.map(n => ({ id: n, label: `${n}d` }))} value={days} onChange={onDays} />
    </div>
  );
}

function ByModelAndObjective({ d, measure }: { d: AgentStats; measure: Measure }) {
  const fmt = measure === "cost" ? money : count;
  const share = (dollars: number) => `${Math.round((dollars / Math.max(1e-9, d.totals.dollars)) * 100)}%`;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Tile label="By model" value={String(d.models.length)} delta={<span className="text-xs text-[var(--viz-text-2)]">models used</span>}>
        <StageBars
          rows={d.models.slice(0, 8).map(m => ({ key: m.model, label: modelName(m.model), value: measure === "cost" ? m.dollars : m.tokens, color: family(m.model)[2], note: measure === "cost" ? share(m.dollars) : undefined }))}
          fmt={fmt}
        />
      </Tile>
      <Tile label="By objective" value={String(d.objectives.length)} delta={<span className="text-xs text-[var(--viz-text-2)]">objectives with spend</span>}>
        <StageBars rows={d.objectives.slice(0, 8).map(o => ({ key: o.id, label: o.title, value: o.dollars, note: o.prs > 0 ? `${money(o.dollars / o.prs)}/PR` : `${o.agents} agents` }))} fmt={money} />
      </Tile>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SkeletonTiles count={4} chart="h-4" />
      </div>
      <SkeletonTile chart="h-56" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <SkeletonTiles count={2} chart="h-48" />
      </div>
      <SkeletonTile chart="h-80" />
    </div>
  );
}

export function Agents({ live, days, onDays }: { live: boolean; days: number; onDays: (n: number) => void }) {
  const [measure, setMeasure] = useState<Measure>("cost");
  const data = useJson<AgentStats>(live ? `/api/stats/agents?days=${days}` : undefined, d => d.scanning);
  const d = data.value;
  if (!d)
    return (
      <section>
        <SectionHead title="Usage">
          <span className={cn("text-xs", hasText(data.error) ? "text-rose-600 dark:text-rose-400" : "text-[var(--viz-text-2)]")}>{data.error ?? "reading Claude Code's transcripts…"}</span>
          <UsageToggles measure={measure} onMeasure={setMeasure} days={days} onDays={onDays} />
        </SectionHead>
        {!hasText(data.error) && <UsageSkeleton />}
      </section>
    );
  const hasNoYarnAgent = d.groups.every(g => g.kind !== "agent");
  return (
    <>
      <section>
        <SectionHead title="Usage">
          <span className="text-xs text-[var(--viz-text-2)]">
            from Claude Code's transcripts, read {new Date(d.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            {d.scanning && " · reading what's new…"}
          </span>
          <UsageToggles measure={measure} onMeasure={setMeasure} days={days} onDays={onDays} />
        </SectionHead>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {kpisOf(d.totals, measure).map(([label, value, note]) => (
              <Tile key={label} label={label} value={value}>
                <div className="mt-1 text-xs text-[var(--viz-text-2)]">{note}</div>
              </Tile>
            ))}
          </div>
          <Daily data={d} measure={measure} />
          <ByModelAndObjective d={d} measure={measure} />
          <AgentTable data={d} measure={measure} />
          {hasNoYarnAgent && <p className="text-xs text-[var(--viz-text-2)]">No yarn agent ran in this range.</p>}
        </div>
      </section>
      <Jev days={days} />
    </>
  );
}
