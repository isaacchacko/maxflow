import { cn } from "@/lib/utils";

export const NAME = "yarn";
export const ABOUT = "yarn: yet another agent routing network";

/** The mark and wordmark: a ball of yarn and the name. favicon.svg is the same ball. */
export function Mark({ className }: { className?: string }) {
  return (
    <span title={ABOUT} className={cn("inline-flex items-center gap-1.5", className)}>
      <svg viewBox="0 0 32 32" aria-hidden className="size-7">
        <circle cx="15" cy="15.4" r="11.6" fill="#c8502b" />
        <path d="M5.8 10c3.8 2.2 6.6 7.4 6 14.4M8.6 6.4c5 1.4 9.6 6.4 10.6 14.6M20.6 5.2c-1.4 3.4-1 8.8 2.4 14" fill="none" stroke="#f7d6c2" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M22.6 24.8c2.2 1.4 3.8 3.4 7.2 3" fill="none" stroke="#c8502b" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <span className="text-lg font-semibold tracking-tight">{NAME}</span>
    </span>
  );
}
