import { cn } from "@/lib/utils";

export const NAME = "yarn";
export const ABOUT = "yarn: yet another agent routing network";

/** The mark and wordmark: the yarn emoji and the name; `compact`, the emoji alone. favicon.svg is the same emoji. */
export function Mark({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span title={ABOUT} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      <span aria-hidden className="text-2xl leading-none">🧶</span>
      {!compact && <span className="text-lg font-semibold tracking-tight">{NAME}</span>}
    </span>
  );
}
