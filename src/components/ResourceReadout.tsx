import { MemoryStick } from "lucide-react";
import { cn } from "@/lib/utils";
import { liveStore } from "@/store";
import { megabytes } from "@/views/stats/Resources";
import { useJson } from "@/views/stats/load";

type Brief = { at: number; total: { rssMb: number; cpu: number }; machine: { totalMb: number; usedMb: number; swapUsedMb: number; swapTotalMb: number } };

const SWAPPING_HARD = 0.85;

export function ResourceReadout({ open }: { open: boolean }) {
  const isLive = liveStore.use();
  const brief = useJson<Brief | null>(isLive ? "/api/stats/resources?brief" : undefined, () => true).value;
  if (!brief) return null;
  const { total, machine } = brief;
  const isSwappingHard = machine.swapUsedMb / Math.max(1, machine.swapTotalMb) > SWAPPING_HARD;
  const title = `yarn: ${megabytes(total.rssMb)} RAM, ${Math.round(total.cpu)}% CPU · machine: ${megabytes(machine.usedMb)} of ${megabytes(machine.totalMb)} used, swap ${megabytes(machine.swapUsedMb)} of ${megabytes(machine.swapTotalMb)}`;
  return (
    <a href="#stats/performance" title={title} data-agent="sidebar:resources" className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-xs whitespace-nowrap text-muted-foreground hover:bg-black/[0.04] hover:text-foreground">
      <MemoryStick className={cn("size-4 shrink-0", isSwappingHard && "text-amber-600 dark:text-amber-400")} />
      {open && (
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate tabular-nums">
          <span className="text-foreground">{megabytes(total.rssMb)}</span>
          <span>yarn</span>
          <span className={cn("ml-auto", isSwappingHard && "text-amber-600 dark:text-amber-400")}>swap {megabytes(machine.swapUsedMb)}</span>
        </span>
      )}
    </a>
  );
}
