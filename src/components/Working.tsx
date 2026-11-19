import { useNow } from "@/lib/effects";
import { cn } from "@/lib/utils";

// The marks of an agent at work. Which goes where: the ring beside a title (sidebar pins, rows), the dots before a working line's
// words (a router's reply on its way, an agent's turn), sparkles for a search or a question being thought through, the comet where
// a line has no face beside it, and the elapsed time after any of them.

/** The ✻ of a router working on an answer: a small turning iridescent ring. */
export function Working({ className }: { className?: string }) {
  return <span role="img" aria-label="working" className={cn("working-ring iris", className)} />;
}

const WAVE = Array.from({ length: 9 }, (_, i) => (((i % 3) + Math.floor(i / 3)) / 4) * 0.75);
const SPIN = Array.from({ length: 9 }, (_, i) => (Math.atan2(Math.floor(i / 3) - 1, (i % 3) - 1) / (2 * Math.PI) + 1) % 1);

/** A 3×3 grid of dots, lit by a wave crossing it diagonally or by a sweep turning around it. */
export function Dots({ spin, className }: { spin?: boolean; className?: string }) {
  return (
    <span role="img" aria-label="working" className={cn("dots", className)}>
      {(spin ? SPIN : WAVE).map((phase, i) => (
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

/** Five four-pointed sparkles, twinkling one after another. */
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

const LOOP = "M28 14C33 5 47 5 47 14S33 23 28 14 9 5 9 14s14 9 19 0Z";

/** A comet running an infinity loop over its faint track. */
export function Comet({ className }: { className?: string }) {
  return (
    <svg role="img" aria-label="working" viewBox="4 3 48 22" className={cn("h-3 w-6 shrink-0", className)}>
      <path d={LOOP} fill="none" stroke="currentColor" strokeWidth="2.75" opacity=".15" />
      <path d={LOOP} pathLength={100} fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeDasharray="11 89" className="comet" />
    </svg>
  );
}

const span = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

/** How long it has been at it, counting: seconds, then minutes and seconds, then hours and minutes (once a minute). */
export function Elapsed({ since, className }: { since: string; className?: string }) {
  const start = Date.parse(since);
  const seconds = (now: number) => Math.max(0, Math.floor((now - start) / 1000));
  const s = seconds(useNow(now => (seconds(now) < 3600 ? 1000 - ((now - start) % 1000) : 60_000)));
  return <span className={cn("shrink-0 font-mono text-[0.95em] whitespace-nowrap text-muted-foreground tabular-nums", className)}>{Number.isFinite(start) ? span(s) : ""}</span>;
}
