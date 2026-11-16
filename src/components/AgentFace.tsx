import { cn } from "@/lib/utils";

// An agent's face: a soft paper body with a deeper edge behind it, and all the expression in the eyes and brows, no mouth.
// Shape, hue and eye spacing come from the agent's id, so each agent keeps one face; its expression follows what it is doing.

export type Expression = "idle" | "thinking" | "waiting" | "done" | "error" | "asleep";

// A body: its outline, where the eyes sit (y, and the widest half-spread that still fits), how much to shrink them, and how
// round to make its corners (polygons are drawn sharp and rounded with a stroke of the same colour).
type Shape = { name: string; d: string; cy: number; spread: number; scale?: number; round?: number; brows?: false; smallZoom?: number; eyes?: [[number, number], [number, number]] };
const SHAPES: Shape[] = [
  { name: "round", d: "M16 4.4c6.8 0 11.6 4.2 11.6 11 0 7.2-4.8 12.2-11.6 12.2S4.4 22.6 4.4 15.4C4.4 8.6 9.2 4.4 16 4.4z", cy: 15.6, spread: 4.6 },
  { name: "squircle", d: "M16 5c6.9 0 10.8.6 11 6.8.2 3.4.2 6.4 0 9.6-.4 5.6-4.4 6.2-11 6.2s-10.6-.6-11-6.2c-.2-3.2-.2-6.2 0-9.6C5.2 5.6 9.1 5 16 5z", cy: 15.6, spread: 4.6 },
  { name: "pebble", d: "M15.4 7.2c7.4-.4 12.8 3 12.8 9.2 0 6.4-5.4 10-12.4 10C8.6 26.4 3.8 23 3.8 17c0-5.8 4.6-9.4 11.6-9.8z", cy: 16.4, spread: 4.6 },
  { name: "bean", d: "M16.6 4c5.6.2 9.4 4.4 9.6 10.6.2 7.6-4 13-10.4 13-6.2 0-9.8-4.6-9.8-11.2C6 9 10.4 3.8 16.6 4z", cy: 15.4, spread: 4.2 },
  { name: "bun", d: "M16 6c7 0 12 4.4 12 10.8v5.6c0 3.2-2 4.6-5 4.6H9c-3 0-5-1.4-5-4.6v-5.6C4 10.4 9 6 16 6z", cy: 17, spread: 4.6 },
  { name: "drop", d: "M17.4 4.2c5.4 1.6 9.6 6.2 9.6 12.2 0 6.4-4.8 11.2-11 11.2S5 22.8 5 16.6C5 9 10.6 2.2 17.4 4.2z", cy: 16.4, spread: 4.2 },
  { name: "cloud", d: "M9 26.4h14.6c3.4 0 5.6-2.3 5.6-5.3 0-2.9-2-5-4.7-5.3.1-4.4-3.4-7.9-7.9-7.9-3 0-5.4 1.6-6.6 4C6.6 12 4 14.8 4 18.6c0 4.2 2.6 7.8 5 7.8z", cy: 19.2, spread: 3.9 },
  { name: "star", d: "M16 6L19.17 13.03L26.84 13.88L21.14 19.07L22.7 26.62L16 22.8L9.3 26.62L10.86 19.07L5.16 13.88L12.83 13.03Z", cy: 17.4, spread: 2.5, scale: 0.75, round: 3.2 },
  { name: "heart", d: "M16 27.4C9.2 22.8 4.2 18.6 4.2 12.8 4.2 9 7 6.2 10.5 6.2c2.4 0 4.3 1.2 5.5 3.2 1.2-2 3.1-3.2 5.5-3.2 3.5 0 6.3 2.8 6.3 6.6 0 5.8-5 10-11.8 14.6z", cy: 14.8, spread: 4.4, scale: 0.9 },
  { name: "diamond", d: "M16 4.6L27.4 16L16 27.4L4.6 16Z", cy: 16, spread: 3.2, scale: 0.85, round: 4 },
  { name: "shield", d: "M5.6 7.6c3.8-.6 7.1-1.9 10.4-3.8 3.3 1.9 6.6 3.2 10.4 3.8v7.6c0 6.8-4.4 11.2-10.4 13.6C10 26.4 5.6 22 5.6 15.2z", cy: 14.6, spread: 3.8 },
  { name: "slender", d: "M16 3.6c5 0 7.6 3.6 7.6 9.4v6.4c0 5.6-3 9.2-7.6 9.2s-7.6-3.6-7.6-9.2V13C8.4 7.2 11 3.6 16 3.6z", cy: 14.6, spread: 3, scale: 0.9 },
  { name: "pocket", d: "M5 9c0-1.8 1.2-2.9 3-2.7 5.4.7 10.6.7 16 0 1.8-.2 3 .9 3 2.7v11.6c0 3.6-2.4 5.6-6 5.6H11c-3.6 0-6-2-6-5.6z", cy: 16.6, spread: 4.6 },
  // Isaac's company, Dryft: its logo's silhouette, eyes riding up the diagonal band.
  { name: "dryft", d: "M20.13 7.2C20.75 6.64 21.74 7.07 21.74 7.91V12.97C21.81 14.34 22.91 15.44 24.29 15.49H27.08C27.69 15.49 28.0 16.24 27.57 16.67L22.31 21.93C21.87 22.36 21.13 22.06 21.13 21.44V17.58C21.12 16.64 20.89 15.87 19.89 15.87C19.13 15.87 18.22 16.57 17.79 16.95L10.58 23.59C9.97 24.16 8.98 23.73 8.98 22.89V17.86C8.96 16.47 7.85 15.33 6.47 15.26H4.92C4.31 15.26 4.0 14.52 4.43 14.08L8.43 10.02C8.86 9.58 9.61 9.89 9.61 10.51V13.34C9.64 14.22 9.89 14.93 10.85 14.93C11.48 14.93 12.2 14.45 12.68 14.08L20.13 7.2Z", cy: 15.9, spread: 2.6, scale: 0.8, round: 1.8, brows: false, smallZoom: 1.26, eyes: [[13.4, 17.1], [17.4, 14.4]] },
];
const HUES = [217, 192, 158, 96, 38, 18, 248, 270, 200];

function hash(id: string) {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function faceOf(id: string) {
  const h = hash(id);
  return { shape: h % SHAPES.length, hue: HUES[(h >>> 4) % HUES.length]!, spread: 0.78 + ((h >>> 9) % 4) * 0.07, phase: (h >>> 13) % 1000 };
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
/** A face's own colours, for a face that wears a brand's rather than one from its id. */
export type Colors = { face: string; edge: string; line: string; ink: string };

function EyeShape({ e, cx, cy, ink }: { e: Eye; cx: number; cy: number; ink: string }) {
  const x = cx + (e.dx ?? 0);
  const y = cy + (e.dy ?? 0);
  if (e.kind === "dot") return <circle cx={x} cy={y} r={e.r} fill={ink} />;
  if (e.kind === "arc") return <path d={`M${x - 1.9} ${y + 0.9}q1.9-3 3.8 0`} fill="none" stroke={ink} strokeWidth="1.7" strokeLinecap="round" />;
  const w = e.w ?? 3.2;
  const h = e.h ?? 6;
  return <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={Math.min(w, h) / 2} fill={ink} transform={e.rot ? `rotate(${e.rot} ${x} ${y})` : undefined} />;
}

/**
 * `expression` sets the eyes and brows; `still` drops every animation (the favicon, lists of many faces); `small` drops the
 * brows, which blur below about 24px.
 */
export function AgentFace({ id, expression = "idle", still, small, shape, colors, className }: { id: string; expression?: Expression; still?: boolean; small?: boolean; shape?: string; colors?: Colors; className?: string }) {
  const f = faceOf(id);
  const body = SHAPES.find(x => x.name === shape) ?? SHAPES[f.shape]!;
  const look = LOOKS[expression];
  const k = body.scale ?? 1;
  const spread = body.spread * f.spread;
  const [[lx, ly], [rx, ry]] = body.eyes ?? [[16 - spread, body.cy], [16 + spread, body.cy]];
  const delay = { animationDelay: `-${f.phase * 9}ms` };
  const { face, edge, line, ink } = colors ?? { face: `hsl(${f.hue} 82% 83%)`, edge: `hsl(${f.hue} 52% 54%)`, line: `hsl(${f.hue} 48% 58%)`, ink: INK };
  const r = body.round ?? 0;
  const eye = (e: Eye, x: number, y: number) => (
    <g transform={`translate(${x} ${y}) scale(${k}) translate(${-x} ${-y})`}>
      <EyeShape e={e} cx={x} cy={y} ink={ink} />
    </g>
  );
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("agent-face shrink-0", !still && `face-${expression}`, className)}>
      <g className="face-sway" style={delay} transform={small && body.smallZoom ? `translate(16 16) scale(${body.smallZoom}) translate(-16 -16)` : undefined}>
        <path d={body.d} transform="translate(1.1 1.5)" fill={edge} stroke={edge} strokeWidth={r} strokeLinejoin="round" />
        {r > 0 && <path d={body.d} fill="none" stroke={line} strokeWidth={r + 1.4} strokeLinejoin="round" />}
        <path d={body.d} fill={face} stroke={r > 0 ? face : line} strokeWidth={r || 0.7} strokeLinejoin="round" />
        <g className="face-look" style={delay}>
          <g className="face-blink" style={delay}>
            {eye(look.left, lx, ly)}
            {eye(look.right, rx, ry)}
          </g>
          {!small &&
            body.brows !== false &&
            look.brows?.map((b, i) => {
              const [x, y] = i ? [rx, ry] : [lx, ly];
              return b && <path key={i} d={`M${x - 2 * k} ${y + (b.y + b.tilt) * k}L${x + 2 * k} ${y + (b.y - b.tilt) * k}`} stroke={ink} strokeOpacity=".6" strokeWidth={1.2 * k} strokeLinecap="round" />;
            })}
        </g>
      </g>
    </svg>
  );
}

/** Every body an agent can have, by name. */
export const SHAPE_NAMES = SHAPES.map(x => x.name);

/** What an agent's state looks like on its face. */
export const expressionOf = (state?: string): Expression => (state === "working" ? "thinking" : state === "waiting" ? "waiting" : state === "asleep" ? "asleep" : "idle");
