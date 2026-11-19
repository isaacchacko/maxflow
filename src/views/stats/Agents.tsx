import { useState } from "react";
import { cn } from "@/lib/utils";
import { useJson } from "./load";
import { SectionHead, Tile, short, weekday } from "./parts";

// What his agents cost and what came of it, like Superset's usage page: Claude Code's own token counts from its transcripts,
// priced at API rates (on a subscription the bill doesn't change; this is what the same work would cost per token), over the
// last 7, 30 or 90 days, as cost or as tokens.

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

// Each model family keeps one hue wherever it shows; anything else is grey.
const FAMILIES: [RegExp, string, string][] = [
  [/opus/, "Opus", "var(--viz)"],
  [/haiku/, "Haiku", "var(--viz-2)"],
  [/sonnet/, "Sonnet", "var(--viz-3)"],
  [/fable|mythos/, "Fable", "var(--viz-4)"],
];
const family = (model: string) => FAMILIES.find(([re]) => re.test(model)) ?? [/./, "Other", "color-mix(in oklab, var(--muted-foreground) 45%, var(--viz-track))"];
const modelName = (model: string) => model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1").replace(/^./, c => c.toUpperCase());

const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
const count = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const tokensOf = (g: Group) => g.tokens.input + g.tokens.output + g.tokens.cacheRead + g.tokens.cacheWrite;
const hours = (ms: number) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(ms >= 36_000_000 ? 0 : 1)}h` : `${Math.round(ms / 60_000)}m`);

/** Columns per day, each a stack of model families over the track, with a legend of the families on screen. */
function Daily({ data, measure }: { data: AgentStats; measure: Measure }) {
  const [hover, setHover] = useState<number>();
  const at = measure === "cost" ? 0 : 1;
  const stacks = data.daily.map(d => {
    const by = new Map<string, { label: string; color: string; v: number }>();
    for (const [m, v] of Object.entries(d.models)) {
      const [, label, color] = family(m);
      const x = by.get(label) ?? by.set(label, { label, color, v: 0 }).get(label)!;
      x.v += v[at];
    }
    return [...by.values()].sort((a, b) => FAMILIES.findIndex(f => f[1] === a.label) - FAMILIES.findIndex(f => f[1] === b.label));
  });
  const totals = stacks.map(s => s.reduce((n, x) => n + x.v, 0));
  const max = Math.max(1e-9, ...totals);
  const shown = [...new Map(stacks.flat().map(x => [x.label, x])).values()];
  const fmt = measure === "cost" ? money : count;
  const h = hover ?? totals.length - 1;
  const ticks = data.days.length > 14 ? [0, Math.floor(data.days.length / 2), data.days.length - 1] : data.days.map((_, i) => i);
  return (
    <Tile
      label={hover === undefined ? `${measure === "cost" ? "Cost" : "Tokens"} per day` : `${weekday(data.days[h]!, "short")} ${short(data.days[h]!)}`}
      value={hover === undefined ? fmt(totals.reduce((a, b) => a + b, 0)) : fmt(totals[h]!)}
      delta={
        hover !== undefined && (
          <span className="flex gap-2 text-xs text-muted-foreground">
            {stacks[h]!.map(x => (
              <span key={x.label} className="flex items-center gap-1">
                <span className="size-2 rounded-sm" style={{ background: x.color }} />
                {x.label} {fmt(x.v)}
              </span>
            ))}
          </span>
        )
      }
      aside={
        <div className="flex gap-3 text-xs text-muted-foreground">
          {shown.map(x => (
            <span key={x.label} className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm" style={{ background: x.color }} />
              {x.label}
            </span>
          ))}
        </div>
      }
    >
      <div className="mt-4 flex h-36 items-end gap-[2px]" onMouseLeave={() => setHover(undefined)}>
        {stacks.map((s, i) => (
          <div key={data.days[i]} onMouseEnter={() => setHover(i)} className="relative flex h-full flex-1 flex-col justify-end overflow-hidden rounded-[4px] bg-[var(--viz-track)]">
            <div className={cn("flex flex-col-reverse gap-[2px] transition-opacity", hover !== undefined && hover !== i && "opacity-40")} style={{ height: `${(totals[i]! / max) * 100}%` }}>
              {s.map(x => (
                <span key={x.label} style={{ flexGrow: x.v, background: x.color }} className="min-h-0" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[2px] text-[10px] leading-none text-muted-foreground">
        {data.days.map((d, i) => (
          <span key={d} className={cn("flex-1 whitespace-nowrap", i === data.days.length - 1 && ticks.length < data.days.length ? "flex justify-end" : "")}>
            {ticks.includes(i) ? short(d) : ""}
          </span>
        ))}
      </div>
    </Tile>
  );
}

/** Ranked bars on one baseline, largest first, one hue. */
function Ranked({ rows, fmt }: { rows: { key: string; label: string; value: number; note?: string; color?: string }[]; fmt(v: number): string }) {
  const top = Math.max(1e-9, ...rows.map(r => r.value));
  return (
    <div className="mt-3 flex flex-col gap-2">
      {rows.map(r => (
        <div key={r.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_7.5rem] items-center gap-3 text-xs">
          <span className="truncate" title={r.label}>
            {r.label}
          </span>
          <span className="relative h-3 overflow-hidden rounded-full bg-[var(--viz-track)]">
            <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `max(${(r.value / top) * 100}%, 0.5rem)`, background: r.color ?? "var(--viz)" }} />
          </span>
          <span className="text-right tabular-nums">
            {fmt(r.value)} {r.note && <span className="text-muted-foreground">{r.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

const KINDS = [
  { id: "agent", label: "yarn agents" },
  { id: "sentry", label: "Sentries" },
  { id: "outside", label: "Outside yarn" },
] as const;

function AgentTable({ data, measure }: { data: AgentStats; measure: Measure }) {
  const [kind, setKind] = useState<Group["kind"]>("agent");
  const [all, setAll] = useState(false);
  const rows = data.groups.filter(g => g.kind === kind).sort((a, b) => (measure === "cost" ? b.dollars - a.dollars : tokensOf(b) - tokensOf(a)));
  const shown = all ? rows : rows.slice(0, 15);
  const top = Math.max(1e-9, ...rows.map(g => (measure === "cost" ? g.dollars : tokensOf(g))));
  return (
    <Tile
      label="Most expensive"
      value={`${rows.length.toLocaleString()} ${KINDS.find(k => k.id === kind)!.label.toLowerCase()}`}
      aside={
        <div className="flex shrink-0 rounded-lg bg-[var(--viz-track)] p-0.5 text-xs">
          {KINDS.map(k => (
            <button key={k.id} onClick={() => setKind(k.id)} className={cn("rounded-md px-2 py-0.5", kind === k.id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {k.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[46rem] table-fixed text-xs">
          <thead className="text-left text-[11px] text-muted-foreground">
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
            {shown.map(g => {
              const v = measure === "cost" ? g.dollars : tokensOf(g);
              const mix = Object.entries(g.models).sort((a, b) => b[1] - a[1]);
              const spent = g.dollars || 1;
              return (
                <tr key={`${g.kind}${g.id}`} className="border-t border-border/60">
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
                    {g.objective && <span className="block truncate text-[11px] text-muted-foreground">{g.role === "router" ? "router · " : ""}{g.objective}</span>}
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-2">
                      {/* The bar splits by model family, so its hues sum to the agent's spend. */}
                      <span className="flex h-2.5 overflow-hidden rounded-full bg-[var(--viz-track)]" style={{ width: `${Math.max(4, (v / top) * 100)}%` }}>
                        {mix.map(([m, d]) => (
                          <span key={m} style={{ width: `${(d / spent) * 100}%`, background: family(m)[2] }} title={`${modelName(m)}: ${money(d)}`} />
                        ))}
                      </span>
                      <span className="shrink-0 tabular-nums">{measure === "cost" ? money(v) : count(v)}</span>
                    </div>
                  </td>
                  <td className="py-1.5 text-right text-muted-foreground tabular-nums">{hours(g.activeMs)}</td>
                  <td className="py-1.5 text-right text-muted-foreground tabular-nums">{g.messages.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums">{g.prs || <span className="text-muted-foreground">–</span>}</td>
                  <td className="py-1.5 text-right tabular-nums">{g.threads || <span className="text-muted-foreground">–</span>}</td>
                  <td className="py-1.5 text-right tabular-nums">{g.prs ? money(g.dollars / g.prs) : <span className="text-muted-foreground">–</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > 15 && (
          <button onClick={() => setAll(!all)} className="mt-2 text-xs text-muted-foreground hover:text-foreground">
            {all ? "Show the top 15" : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </Tile>
  );
}

export function Agents({ live, days, onDays }: { live: boolean; days: number; onDays(n: number): void }) {
  const [measure, setMeasure] = useState<Measure>("cost");
  const data = useJson<AgentStats>(live ? `/api/stats/agents?days=${days}` : undefined, d => d.scanning);
  const d = data.value;
  if (!d) return <p className={cn("text-sm", data.error ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>{data.error ?? "Reading Claude Code's transcripts…"}</p>;
  const t = d.totals;
  const tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  const yarnAgents = d.groups.filter(g => g.kind === "agent");
  const fmt = measure === "cost" ? money : count;
  const kpis: [string, string, string?][] = [
    [measure === "cost" ? "Cost at API rates" : "Tokens", measure === "cost" ? money(t.dollars) : count(tokens), measure === "cost" ? `${money(t.yarnDollars)} in yarn` : `${count(t.output)} written`],
    ["Saved by the cache", money(t.saved), `${Math.round((t.cacheRead / Math.max(1, t.input + t.cacheRead + t.cacheWrite)) * 100)}% of input read from it`],
    ["Agent hours", hours(t.activeMs), `${t.agents} yarn agents · ${t.messages.toLocaleString()} messages`],
    ["Per merged PR", t.prs ? money(t.yarnDollars / t.prs) : "–", `${t.prs} merged · ${t.threads ? money(t.yarnDollars / t.threads) : "–"} per resolved thread`],
  ];
  return (
    <>
      <section>
        <SectionHead title="Usage">
          <span className="text-xs text-muted-foreground">
            from Claude Code's transcripts, read {new Date(d.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            {d.scanning && " · reading what's new…"}
          </span>
          <div className="ml-auto flex gap-2">
            <div className="flex rounded-lg bg-[var(--viz-track)] p-0.5 text-xs">
              {(["cost", "tokens"] as const).map(m => (
                <button key={m} onClick={() => setMeasure(m)} className={cn("rounded-md px-2 py-0.5 capitalize", measure === m ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {m}
                </button>
              ))}
            </div>
            <div className="flex rounded-lg bg-[var(--viz-track)] p-0.5 text-xs">
              {RANGES.map(n => (
                <button key={n} onClick={() => onDays(n)} className={cn("rounded-md px-2 py-0.5 tabular-nums", days === n ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {n}d
                </button>
              ))}
            </div>
          </div>
        </SectionHead>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {kpis.map(([label, value, note]) => (
              <Tile key={label} label={label} value={value}>
                <div className="mt-1 text-xs text-muted-foreground">{note}</div>
              </Tile>
            ))}
          </div>
          <Daily data={d} measure={measure} />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Tile label="By model" value={String(d.models.length)} delta={<span className="text-xs text-muted-foreground">models used</span>}>
              <Ranked
                rows={d.models.slice(0, 8).map(m => ({ key: m.model, label: modelName(m.model), value: measure === "cost" ? m.dollars : m.tokens, color: family(m.model)[2], note: measure === "cost" ? `${Math.round((m.dollars / Math.max(1e-9, t.dollars)) * 100)}%` : undefined }))}
                fmt={fmt}
              />
            </Tile>
            <Tile label="By objective" value={String(d.objectives.length)} delta={<span className="text-xs text-muted-foreground">objectives with spend</span>}>
              <Ranked rows={d.objectives.slice(0, 8).map(o => ({ key: o.id, label: o.title, value: o.dollars, note: o.prs ? `${money(o.dollars / o.prs)}/PR` : `${o.agents} agents` }))} fmt={money} />
            </Tile>
          </div>
          <AgentTable data={d} measure={measure} />
          {!yarnAgents.length && <p className="text-xs text-muted-foreground">No yarn agent ran in this range.</p>}
        </div>
      </section>
    </>
  );
}
