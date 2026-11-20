import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn, hasText } from "@/lib/utils";
import { useJson } from "./load";
import { Ago, SectionHead, Skeleton, SkeletonTile, SkeletonTiles, Tile } from "./parts";

type Usage = { rssMb: number; cpu: number };
type ProcRow = Usage & { pid: number; name: string };
type Group = Usage & { id: string; name: string; kind: "server" | "agent" | "sentry" | "shell"; chrome?: Usage; procs: ProcRow[]; history: number[] };
type Sample = { at: number; rssMb: number; cpu: number; usedMb: number; swapUsedMb: number };
export type Resources = { at: number; everyMs: number; total: Usage; machine: { totalMb: number; usedMb: number; swapUsedMb: number; swapTotalMb: number }; groups: Group[]; samples: Sample[] };

const HIGH = 0.85;
const NOTE = "text-xs text-[var(--viz-text-2)]";
const KIND_LABEL: Record<Group["kind"], string> = { server: "server", agent: "agent", sentry: "sentry", shell: "shell" };

export const megabytes = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10_240 ? 0 : 1)} GB` : `${Math.round(mb)} MB`);
const percent = (cpu: number) => `${cpu >= 10 ? Math.round(cpu) : cpu.toFixed(1)}%`;

export const useResources = (isLive: boolean) => useJson<Resources | null>(isLive ? "/api/stats/resources" : undefined, () => true);

export function Sparkline({ values, className, max }: { values: number[]; className?: string; max?: number }) {
  if (values.length < 2) return <div className={cn("rounded-md bg-[var(--viz-track)]", className)} />;
  const top = Math.max(1e-9, max ?? Math.max(...values));
  const bottom = max === undefined ? Math.min(...values) * 0.9 : 0;
  const span = Math.max(1e-9, top - bottom);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - bottom) / span) * 28}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("overflow-visible", className)} aria-hidden>
      <polygon points={`0,30 ${points} 100,30`} fill="color-mix(in oklab, var(--viz) 18%, transparent)" />
      <polyline points={points} fill="none" stroke="var(--viz)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function Meter({ share }: { share: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-[var(--viz-track)]">
      <div className={cn("h-full rounded-full", share > HIGH ? "bg-rose-500" : "bg-[var(--viz)]")} style={{ width: `${Math.min(1, share) * 100}%` }} />
    </div>
  );
}

function Kpis({ r }: { r: Resources }) {
  const { machine, samples } = r;
  const swapShare = machine.swapUsedMb / Math.max(1, machine.swapTotalMb);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="yarn RAM" value={megabytes(r.total.rssMb)} delta={<span className={NOTE}>{Math.round((r.total.rssMb / Math.max(1, machine.totalMb)) * 100)}% of the machine</span>}>
        <Sparkline values={samples.map(s => s.rssMb)} className="h-12 w-full" />
      </Tile>
      <Tile label="yarn CPU" value={percent(r.total.cpu)} delta={<span className={NOTE}>100% is one core</span>}>
        <Sparkline values={samples.map(s => s.cpu)} className="h-12 w-full" />
      </Tile>
      <Tile label="Machine RAM" value={`${megabytes(machine.usedMb)} used`} delta={<span className={NOTE}>{megabytes(Math.max(0, machine.totalMb - machine.usedMb))} free</span>}>
        <div className="flex flex-col gap-2">
          <Meter share={machine.usedMb / Math.max(1, machine.totalMb)} />
          <Sparkline values={samples.map(s => s.usedMb)} max={machine.totalMb} className="h-8 w-full" />
        </div>
      </Tile>
      <Tile label="Swap" value={megabytes(machine.swapUsedMb)} delta={<span className={cn(NOTE, swapShare > HIGH && "text-rose-700 dark:text-rose-300")}>of {megabytes(machine.swapTotalMb)}</span>}>
        <div className="flex flex-col gap-2">
          <Meter share={swapShare} />
          <Sparkline values={samples.map(s => s.swapUsedMb)} max={Math.max(1, machine.swapTotalMb)} className="h-8 w-full" />
        </div>
      </Tile>
    </div>
  );
}

function GroupName({ g }: { g: Group }) {
  if (g.kind === "server") return <span className="truncate font-medium">{g.name}</span>;
  return (
    <a href={`#agent/${g.id}`} onClick={e => e.stopPropagation()} className="truncate font-medium hover:underline" title={`Open ${g.name}`}>
      {g.name}
    </a>
  );
}

const ROW = "grid grid-cols-[1rem_minmax(0,1fr)_4.5rem_4rem] items-center gap-2 sm:grid-cols-[1rem_minmax(0,1fr)_3.5rem_6rem_4.5rem_4rem]";

function GroupRow({ g, top }: { g: Group; top: number }) {
  const [isOpen, setOpen] = useState(false);
  return (
    <li className="border-b border-[var(--viz-track)] last:border-b-0">
      <div role="button" tabIndex={0} onClick={() => setOpen(o => !o)} onKeyDown={e => e.key === "Enter" && setOpen(o => !o)} className={cn(ROW, "cursor-pointer py-2 text-sm text-[var(--viz-text)]")}>
        <ChevronRight className={cn("size-3.5 text-[var(--viz-text-3)] transition-transform", isOpen && "rotate-90")} />
        <span className="flex min-w-0 items-center gap-2">
          <GroupName g={g} />
          {g.chrome && <span className="shrink-0 rounded-md bg-[var(--viz-track)] px-1.5 text-[11px] text-[var(--viz-text-2)]">Chrome {megabytes(g.chrome.rssMb)}</span>}
        </span>
        <span className="hidden text-[11px] text-[var(--viz-text-3)] sm:block">{KIND_LABEL[g.kind]}</span>
        <Sparkline values={g.history} max={top} className="hidden h-5 w-full sm:block" />
        <span className="text-right font-medium tabular-nums">{megabytes(g.rssMb)}</span>
        <span className="text-right text-[var(--viz-text-2)] tabular-nums">{percent(g.cpu)}</span>
      </div>
      {isOpen && (
        <ul className="mb-2 ml-6 flex flex-col gap-1">
          {g.procs.map(p => (
            <li key={p.pid} className="grid grid-cols-[minmax(0,1fr)_4.5rem_4rem] gap-2 text-xs text-[var(--viz-text-2)]">
              <span className="truncate" title={`pid ${p.pid}`}>
                {p.name} <span className="text-[var(--viz-text-3)]">{p.pid}</span>
              </span>
              <span className="text-right tabular-nums">{megabytes(p.rssMb)}</span>
              <span className="text-right tabular-nums">{percent(p.cpu)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Trees({ r }: { r: Resources }) {
  const top = Math.max(1, ...r.groups.flatMap(g => g.history));
  return (
    <Tile label="By process tree" value={String(r.groups.length)} delta={<span className={NOTE}>server, then each session's claude, shells and Chrome · heaviest first</span>}>
      <div className="flex flex-col">
      <div className={cn(ROW, "border-b border-[var(--viz-track)] pb-1 text-[11px] text-[var(--viz-text-3)]")}>
        <span />
        <span>Session</span>
        <span className="hidden sm:block">Kind</span>
        <span className="hidden sm:block">Last hour</span>
        <span className="text-right">RAM</span>
        <span className="text-right">CPU</span>
      </div>
      <ul className="flex max-h-[32rem] flex-col overflow-y-auto">
        {r.groups.map(g => (
          <GroupRow key={g.id} g={g} top={top} />
        ))}
      </ul>
      </div>
    </Tile>
  );
}

function ResourcesSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SkeletonTiles count={4} chart="h-12" />
      </div>
      <SkeletonTile chart={false}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </SkeletonTile>
    </div>
  );
}

export function ResourcesSection({ live }: { live: boolean }) {
  const data = useResources(live);
  const r = data.value ?? undefined;
  return (
    <section>
      <SectionHead title="Resource use">
        <span className={NOTE}>{r ? <>sampled every {r.everyMs / 1000}s with ps, last hour kept · <Ago at={r.at} /></> : "sampling processes…"}</span>
        {hasText(data.error) && <span className="text-xs text-rose-600 dark:text-rose-400">{data.error}</span>}
      </SectionHead>
      {r ? (
        <div className="flex flex-col gap-3">
          <Kpis r={r} />
          <Trees r={r} />
        </div>
      ) : (
        <ResourcesSkeleton />
      )}
    </section>
  );
}
