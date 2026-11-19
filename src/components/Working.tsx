import { useNow } from "@/lib/effects";
import { cn } from "@/lib/utils";

export function Working({ className }: { className?: string }) {
  return <span role="img" aria-label="working" className={cn("working-ring iris", className)} />;
}

const DIAGONAL_WAVE = Array.from({ length: 9 }, (_, i) => (((i % 3) + Math.floor(i / 3)) / 4) * 0.75);
const TURNING_SWEEP = Array.from({ length: 9 }, (_, i) => (Math.atan2(Math.floor(i / 3) - 1, (i % 3) - 1) / (2 * Math.PI) + 1) % 1);

export function Dots({ spin, className }: { spin?: boolean; className?: string }) {
  return (
    <span role="img" aria-label="working" className={cn("dots", className)}>
      {(spin === true ? TURNING_SWEEP : DIAGONAL_WAVE).map((phase, i) => (
        <i key={i} style={{ animationDelay: `${((phase - 1) * 0.8).toFixed(3)}s` }} />
      ))}
    </span>
  );
}

const STARS = [
  { x: 50, y: 46, s: 1 },
  { x: 18, y: 22, s: 0.55 },
  { x: 82, y: 26, s: 0.45 },
  { x: 78, y: 76, s: 0.55 },
  { x: 22, y: 78, s: 0.4 },
];

export function Sparkles({ className }: { className?: string }) {
  return (
    <span role="img" aria-label="thinking" className={cn("sparkles relative inline-block size-4 shrink-0", className)}>
      {STARS.map((t, i) => (
        <svg key={i} viewBox="0 0 24 24" style={{ left: `${t.x}%`, top: `${t.y}%`, width: `${t.s * 70}%`, height: `${t.s * 70}%`, marginLeft: `${-t.s * 35}%`, marginTop: `${-t.s * 35}%`, animationDelay: `${(i * 0.196).toFixed(3)}s` }}>
          <path d="M12 1.5c.9 5.6 4.2 9.3 10.5 10.5-6.3 1.2-9.6 4.9-10.5 10.5C11.1 16.9 7.8 13.2 1.5 12 7.8 10.8 11.1 7.1 12 1.5z" fill="currentColor" />
        </svg>
      ))}
    </span>
  );
}

const INFINITY_LOOP = "M28 14C33 5 47 5 47 14S33 23 28 14 9 5 9 14s14 9 19 0Z";

export function Comet({ className }: { className?: string }) {
  return (
    <svg role="img" aria-label="working" viewBox="4 3 48 22" className={cn("h-3 w-6 shrink-0", className)}>
      <path d={INFINITY_LOOP} fill="none" stroke="currentColor" strokeWidth="2.75" opacity=".15" />
      <path d={INFINITY_LOOP} pathLength={100} fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeDasharray="11 89" className="comet" />
    </svg>
  );
}

function elapsedText(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function Elapsed({ since, className }: { since: string; className?: string }) {
  const start = Date.parse(since);
  const seconds = (now: number) => Math.max(0, Math.floor((now - start) / 1000));
  const s = seconds(useNow(now => (seconds(now) < 3600 ? 1000 - ((now - start) % 1000) : 60_000)));
  return <span className={cn("shrink-0 font-mono text-[0.95em] whitespace-nowrap text-muted-foreground tabular-nums", className)}>{Number.isFinite(start) ? elapsedText(s) : ""}</span>;
}
