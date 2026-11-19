import { cn } from "@/lib/utils";

export const NAME = "yarn";
export const ABOUT = "yarn: yet another agent routing network";

export function Mark({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span title={ABOUT} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      <span aria-hidden className="text-2xl leading-none">🧶</span>
      {compact !== true && <span className="text-lg font-semibold tracking-tight">{NAME}</span>}
    </span>
  );
}
