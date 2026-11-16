import { cn } from "@/lib/utils";

// An agent's face: a soft paper body with a deeper edge behind it, and all the expression in the eyes and brows, no mouth.
// Shape, hue and eye spacing come from the agent's id, so each agent keeps one face; its expression follows what it is doing.

export type Expression = "idle" | "thinking" | "waiting" | "done" | "error" | "asleep";

const SHAPES = [
  // round
  "M16 4.4c6.8 0 11.6 4.2 11.6 11 0 7.2-4.8 12.2-11.6 12.2S4.4 22.6 4.4 15.4C4.4 8.6 9.2 4.4 16 4.4z",
  // squircle
  "M16 5c6.9 0 10.8.6 11 6.8.2 3.4.2 6.4 0 9.6-.4 5.6-4.4 6.2-11 6.2s-10.6-.6-11-6.2c-.2-3.2-.2-6.2 0-9.6C5.2 5.6 9.1 5 16 5z",
  // pebble
  "M15.4 7.2c7.4-.4 12.8 3 12.8 9.2 0 6.4-5.4 10-12.4 10C8.6 26.4 3.8 23 3.8 17c0-5.8 4.6-9.4 11.6-9.8z",
  // bean
  "M16.6 4c5.6.2 9.4 4.4 9.6 10.6.2 7.6-4 13-10.4 13-6.2 0-9.8-4.6-9.8-11.2C6 9 10.4 3.8 16.6 4z",
  // bun
  "M16 6c7 0 12 4.4 12 10.8v5.6c0 3.2-2 4.6-5 4.6H9c-3 0-5-1.4-5-4.6v-5.6C4 10.4 9 6 16 6z",
  // drop
  "M17.4 4.2c5.4 1.6 9.6 6.2 9.6 12.2 0 6.4-4.8 11.2-11 11.2S5 22.8 5 16.6C5 9 10.6 2.2 17.4 4.2z",
];
const HUES = [217, 192, 158, 96, 38, 18, 248, 270, 200];

function hash(id: string) {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function faceOf(id: string) {
  const h = hash(id);
  return { shape: h % SHAPES.length, hue: HUES[(h >>> 4) % HUES.length]!, spread: 3.6 + ((h >>> 9) % 4) * 0.35, phase: (h >>> 13) % 1000 };
}

type Eye = { kind: "pill" | "dot" | "arc" | "line"; w?: number; h?: number; r?: number; dx?: number; dy?: number; rot?: number };
type Brow = { y: number; tilt: number } | null;
type Look = { left: Eye; right: Eye; brows?: [Brow, Brow] };

const pill = (h = 6, extra: Partial<Eye> = {}): Eye => ({ kind: "pill", w: 3.2, h, ...extra });
const LOOKS: Record<Expression, Look> = {
  idle: { left: pill(), right: pill() },
  thinking: { left: pill(5.4, { dx: 0.7, dy: -0.8 }), right: { kind: "dot", r: 1.7, dx: 0.7, dy: -0.4 }, brows: [{ y: -5.4, tilt: 0 }, { y: -6.2, tilt: -0.9 }] },
  waiting: { left: pill(6.6, { rot: -6 }), right: pill(6.6, { rot: 6 }), brows: [{ y: -6.6, tilt: 0.6 }, { y: -6.6, tilt: -0.6 }] },
  done: { left: { kind: "arc" }, right: { kind: "arc" } },
  error: { left: { kind: "dot", r: 1.7, dy: 0.6 }, right: { kind: "dot", r: 1.7, dy: 0.6 }, brows: [{ y: -4.6, tilt: 1.1 }, { y: -4.6, tilt: -1.1 }] },
  asleep: { left: { kind: "line", w: 3.6, h: 1.3, dy: 1.2 }, right: { kind: "line", w: 3.6, h: 1.3, dy: 1.2 } },
};

const INK = "#121216";

function EyeShape({ e, cx, cy }: { e: Eye; cx: number; cy: number }) {
  const x = cx + (e.dx ?? 0);
  const y = cy + (e.dy ?? 0);
  if (e.kind === "dot") return <circle cx={x} cy={y} r={e.r} fill={INK} />;
  if (e.kind === "arc") return <path d={`M${x - 1.9} ${y + 0.9}q1.9-3 3.8 0`} fill="none" stroke={INK} strokeWidth="1.7" strokeLinecap="round" />;
  const w = e.w ?? 3.2;
  const h = e.h ?? 6;
  return <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={Math.min(w, h) / 2} fill={INK} transform={e.rot ? `rotate(${e.rot} ${x} ${y})` : undefined} />;
}

/**
 * `expression` sets the eyes and brows; `still` drops every animation (the favicon, lists of many faces); `small` drops the
 * brows, which blur below about 24px.
 */
export function AgentFace({ id, expression = "idle", still, small, className }: { id: string; expression?: Expression; still?: boolean; small?: boolean; className?: string }) {
  const f = faceOf(id);
  const look = LOOKS[expression];
  const cy = 15.6;
  const [lx, rx] = [16 - f.spread, 16 + f.spread];
  const delay = { animationDelay: `-${f.phase * 9}ms` };
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("agent-face shrink-0", !still && `face-${expression}`, className)}>
      <g className="face-sway" style={delay}>
        <path d={SHAPES[f.shape]} transform="translate(1.1 1.5)" fill={`hsl(${f.hue} 52% 54%)`} />
        <path d={SHAPES[f.shape]} fill={`hsl(${f.hue} 82% 83%)`} stroke={`hsl(${f.hue} 48% 58%)`} strokeWidth=".7" />
        <g className="face-look" style={delay}>
          <g className="face-blink" style={delay}>
            <EyeShape e={look.left} cx={lx} cy={cy} />
            <EyeShape e={look.right} cx={rx} cy={cy} />
          </g>
          {!small &&
            look.brows?.map(
              (b, i) =>
                b && <path key={i} d={`M${(i ? rx : lx) - 2} ${cy + b.y + b.tilt}L${(i ? rx : lx) + 2} ${cy + b.y - b.tilt}`} stroke={INK} strokeOpacity=".6" strokeWidth="1.2" strokeLinecap="round" />,
            )}
        </g>
      </g>
    </svg>
  );
}

/** What an agent's state looks like on its face. */
export const expressionOf = (state?: string): Expression => (state === "working" ? "thinking" : state === "waiting" ? "waiting" : state === "asleep" ? "asleep" : "idle");
