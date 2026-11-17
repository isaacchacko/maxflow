import { cn } from "@/lib/utils";

export const NAME = "yarn";
export const ABOUT = "yarn: yet another agent routing network";

/** The mark and wordmark: the yarn emoji and the name. favicon.svg is the same emoji. */
export function Mark({ className }: { className?: string }) {
  return (
    <span title={ABOUT} className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden className="text-2xl leading-none">🧶</span>
      <span className="text-lg font-semibold tracking-tight">{NAME}</span>
    </span>
  );
}
