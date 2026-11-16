import { useId } from "react";
import { cn } from "@/lib/utils";

/** maxflow's mark: the router-working ring standing still, around a solid centre. favicon.svg is the same drawing. */
export function Mark({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="maxflow" className={cn("size-6", className)}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2673fe" />
          <stop offset=".38" stopColor="#22c3d6" />
          <stop offset=".68" stopColor="#8ad14f" />
          <stop offset="1" stopColor="#ffb83c" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="11" fill="none" stroke={`url(#${gradient})`} strokeWidth="5" />
      <circle cx="16" cy="16" r="4.2" className="fill-foreground" />
    </svg>
  );
}
