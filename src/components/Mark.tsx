import { useId } from "react";
import { cn } from "@/lib/utils";

/** maxflow's mark: an agent face in the router-working gradient, now and then blinking and glancing aside. favicon.svg is the same face, still. */
export function Mark({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="maxflow" className={cn("size-7", className)}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2673fe" />
          <stop offset=".4" stopColor="#22c3d6" />
          <stop offset=".72" stopColor="#8ad14f" />
          <stop offset="1" stopColor="#ffb83c" />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradient})`} d="M16 3.2c7.6 0 12.8 4.6 12.8 12.2 0 7.9-5.3 13.4-12.8 13.4S3.2 23.3 3.2 15.4C3.2 7.8 8.4 3.2 16 3.2z" />
      <g className="mark-glance">
        <g className="mark-blink">
          <rect x="10.4" y="11.6" width="3.8" height="7" rx="1.9" fill="#0a0a0a" />
          <rect x="17.8" y="11.6" width="3.8" height="7" rx="1.9" fill="#0a0a0a" />
          <rect x="11.3" y="12.6" width="1.4" height="1.9" rx=".7" fill="#fff" opacity=".85" />
          <rect x="18.7" y="12.6" width="1.4" height="1.9" rx=".7" fill="#fff" opacity=".85" />
        </g>
      </g>
    </svg>
  );
}
