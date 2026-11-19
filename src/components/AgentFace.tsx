import { cn } from "@/lib/utils";
import { useLatest } from "@/lib/effects";
import { useCallback, useId, useMemo, useState } from "react";
import { GRAIN_STYLE, softLightGrainTile } from "./face/grain";
import { paint, SLEEPING_Z, zAt, type Geometry, type Painted } from "./face/paint";
import { createLife, restFrame, type Expression } from "./face/rig";
import { faceOf, hash, SHAPES, shapeFor, type Shape } from "./face/shapes";
import { faceElements, startLiving } from "./face/ticker";

export type { Expression } from "./face/rig";
export { faceOf } from "./face/shapes";

const INK = "#121216";
export type Colors = { face: string; edge: string; line: string; ink: string };

const shouldReduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

type FaceProps = { id: string; expression?: Expression; still?: boolean; small?: boolean; shape?: string; colors?: Colors; className?: string };

function useFaceGeometry({ id, shape, colors, small }: FaceProps) {
  const f = faceOf(id);
  const body = shapeFor(id, shape);
  const k = body.scale ?? 1;
  const spread = body.spread * f.spread;
  const [[lx, ly], [rx, ry]] = body.eyes ?? [
    [16 - spread, body.cy],
    [16 + spread, body.cy],
  ];
  const { face, edge, line, ink } = colors ?? { face: `hsl(${f.hue} 82% 83%)`, edge: `hsl(${f.hue} 52% 54%)`, line: `hsl(${f.hue} 48% 58%)`, ink: INK };
  const r = body.round ?? 0;
  const isSmall = small === true;
  const hasBrows = !isSmall && body.brows !== false;
  const geometry: Geometry = useMemo(() => ({ lx, ly, rx, ry, k, brows: hasBrows, small: isSmall, face, back: line, line, round: r > 0 }), [lx, ly, rx, ry, k, hasBrows, isSmall, face, line, r]);
  return { body, k, r, rx, ry, edge, line, ink, isSmall, geometry };
}

function useLivingFace(id: string, expression: Expression, isAnimated: boolean, geometry: Geometry) {
  const [first] = useState(expression);
  const latestExpression = useLatest(expression);
  const mount = useCallback(
    (svg: SVGSVGElement) => {
      if (!isAnimated || shouldReduceMotion()) return;
      const els = faceElements(svg);
      if (!els) return;
      const me = { life: createLife(hash(id) ^ (Math.random() * 2 ** 32), first), target: () => latestExpression.current, geometry, visible: true, els };
      const stopLiving = startLiving(me);
      const io = new IntersectionObserver(([e]) => {
        me.visible = e?.isIntersecting === true;
      });
      io.observe(svg);
      return () => {
        io.disconnect();
        stopLiving();
      };
    },
    [isAnimated, id, first, latestExpression, geometry],
  );
  return { mount, first };
}

type GrainProps = { uid: string; tile: string; body: Shape; p: Painted; isAnimated: boolean };

function GrainDefs({ uid, tile, body, p, isAnimated }: GrainProps) {
  return (
    <defs>
      <pattern id={`${uid}g`} patternUnits="userSpaceOnUse" width="8" height="8">
        <image href={tile} width="8" height="8" style={{ imageRendering: "pixelated" }} />
      </pattern>
      <clipPath id={`${uid}b`}>
        <path d={body.d} />
      </clipPath>
      <clipPath id={`${uid}s`}>
        <path data-face="shadow-clip" d={body.d} transform={`${p.cap} translate(1.1 1.5)`} />
        {isAnimated &&
          p.slabs.map((t, i) => (
            <path key={i} data-face="slab-clip" d={body.d} transform={t} />
          ))}
      </clipPath>
    </defs>
  );
}

type CapProps = { uid: string; tile: string; body: Shape; p: Painted; r: number; k: number; line: string; ink: string };

function FaceCap({ uid, tile, body, p, r, k, line, ink }: CapProps) {
  return (
    <g data-face="cap" transform={p.cap}>
      {r > 0 && <path d={body.d} fill="none" stroke={line} strokeWidth={r + 1.4} strokeLinejoin="round" />}
      <path data-face="cap-fill" d={body.d} fill={p.capFill} stroke={r > 0 ? p.capFill : line} strokeWidth={r === 0 ? 0.7 : r} strokeLinejoin="round" />
      {tile !== "" && <rect x="-4" y="-4" width="40" height="40" fill={`url(#${uid}g)`} clipPath={`url(#${uid}b)`} style={GRAIN_STYLE} />}
      <g data-face="eyes" opacity={p.eyes}>
        <path data-face="left" d={p.left} fill={ink} />
        <path data-face="right" d={p.right} fill={ink} />
        <g data-face="brows" opacity={p.browOpacity} stroke={ink} strokeWidth={1.2 * k} strokeLinecap="round" fill="none">
          <path data-face="brow-l" d={p.browL} />
          <path data-face="brow-r" d={p.browR} />
        </g>
      </g>
    </g>
  );
}

type ZsProps = { p: Painted; isStill: boolean; isAsleep: boolean; rx: number; ry: number; ink: string };

function SleepingZs({ p, isStill, isAsleep, rx, ry, ink }: ZsProps) {
  return p.zs.map((z, i) => (
    <path
      key={i}
      data-face="z"
      d={SLEEPING_Z}
      transform={isStill ? zAt(rx + 3 + i * 3, ry - 4 - i * 4, z.s) : zAt(z.x, z.y, z.s)}
      opacity={isStill && isAsleep ? 0.7 - i * 0.2 : z.o}
      fill="none"
      stroke={ink}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ));
}

const smallZoomOf = (body: Shape, isSmall: boolean) => (isSmall && body.smallZoom !== undefined ? `translate(16 16) scale(${body.smallZoom}) translate(-16 -16)` : undefined);

export function AgentFace(props: FaceProps) {
  const { id, expression = "idle", still, className } = props;
  const { body, k, r, rx, ry, edge, line, ink, isSmall, geometry } = useFaceGeometry(props);
  const uid = useId().replaceAll(":", "");
  const tile = isSmall ? "" : softLightGrainTile();
  const isStill = still === true;
  const isAnimated = !isStill;
  const { mount, first } = useLivingFace(id, expression, isAnimated, geometry);
  const p = paint(restFrame(isAnimated ? first : expression), geometry);
  return (
    <svg ref={mount} viewBox="0 0 32 32" aria-hidden overflow="visible" className={cn("agent-face shrink-0", className)}>
      <g data-face="head" transform={p.head}>
        <g transform={smallZoomOf(body, isSmall)}>
          <g data-face="shadow" transform={p.cap}>
            <path d={body.d} transform="translate(1.1 1.5)" fill={edge} stroke={edge} strokeWidth={r} strokeLinejoin="round" />
          </g>
          {tile !== "" && <GrainDefs uid={uid} tile={tile} body={body} p={p} isAnimated={isAnimated} />}
          {isAnimated && p.slabs.map((t, i) => <path key={i} data-face="slab" d={body.d} transform={t} fill={edge} stroke={edge} strokeWidth={r + 0.8} strokeLinejoin="round" />)}
          {tile !== "" && <rect x="-4" y="-4" width="40" height="40" fill={`url(#${uid}g)`} clipPath={`url(#${uid}s)`} style={GRAIN_STYLE} />}
          <FaceCap uid={uid} tile={tile} body={body} p={p} r={r} k={k} line={line} ink={ink} />
        </g>
      </g>
      {(expression === "asleep" || isAnimated) && <SleepingZs p={p} isStill={isStill} isAsleep={expression === "asleep"} rx={rx} ry={ry} ink={ink} />}
    </svg>
  );
}

export const SHAPE_NAMES = SHAPES.map(x => x.name);

export function expressionOf(state?: string): Expression {
  if (state === "working" || state === "waiting" || state === "asleep") return state;
  return "idle";
}
