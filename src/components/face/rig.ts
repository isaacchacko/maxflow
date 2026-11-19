// constraint: the motion follows BoardUI's Agent Creator, whose mechanics docs/face-motion.md writes down; the numbers here are ours

export type Expression = "idle" | "thinking" | "working" | "waiting" | "done" | "error" | "asleep";

export type Pose = {
  leftOpen: number;
  rightOpen: number;
  width: number;
  smile: number;
  leftAngle: number;
  rightAngle: number;
  brow: number;
  browAngle: number;
  browLift: number;
  browAsym: number;
  lookX: number;
  lookY: number;
  tilt: number;
  bounce: number;
  tremble: number;
};

type Point = [number, number];
type DriftOffsets = [open: number, asymmetry: number, tilt: number];
type LookBox = [x0: number, y0: number, x1: number, y1: number];

const NEUTRAL: Pose = { leftOpen: 1, rightOpen: 1, width: 1, smile: 0, leftAngle: 0, rightAngle: 0, brow: 0, browAngle: 0, browLift: 0, browAsym: 0, lookX: 0, lookY: 0, tilt: 0, bounce: 0, tremble: 0 };

export const POSES: Record<Expression, Pose> = {
  idle: NEUTRAL,
  thinking: { ...NEUTRAL, leftOpen: 0.78, rightOpen: 0.5, brow: 0.9, browAngle: -0.1, browLift: 0.6, browAsym: 1, lookX: 0.5, lookY: -0.65, tilt: 0.12 },
  working: { ...NEUTRAL, leftOpen: 0.46, rightOpen: 0.46, width: 1.25, leftAngle: 0.08, rightAngle: -0.08, brow: 0.45, browAngle: 0.12, browLift: -0.4, lookY: 0.25 },
  waiting: { ...NEUTRAL, leftOpen: 1.16, rightOpen: 1.16, width: 0.95, brow: 0.85, browAngle: -0.25, browLift: 0.9, tilt: -0.1, lookY: -0.1 },
  done: { ...NEUTRAL, leftOpen: 0.8, rightOpen: 0.8, width: 1.4, smile: 1, bounce: 1 },
  error: { ...NEUTRAL, leftOpen: 1.08, rightOpen: 1.08, width: 0.78, brow: 1, browAngle: -0.75, browLift: 0.5, lookY: 0.35, tremble: 0.35 },
  asleep: { ...NEUTRAL, leftOpen: 0.12, rightOpen: 0.15, width: 1.22, leftAngle: 0.08, rightAngle: -0.08, lookY: 0.5, tilt: 0.1 },
};

const KEYS: (keyof Pose)[] = [
  "leftOpen",
  "rightOpen",
  "width",
  "smile",
  "leftAngle",
  "rightAngle",
  "brow",
  "browAngle",
  "browLift",
  "browAsym",
  "lookX",
  "lookY",
  "tilt",
  "bounce",
  "tremble",
];
const NEVER_BELOW_ZERO = new Set<keyof Pose>(["leftOpen", "rightOpen", "width", "bounce", "tremble", "smile", "brow"]);
const NEVER_ABOVE_ONE = new Set<keyof Pose>(["smile", "brow"]);

const seededUniform = (seed: number) => {
  const start = seed >>> 0;
  let s = start === 0 ? 1 : start;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};
const smooth = (t: number) => t * t * (3 - 2 * t);
const smoother = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (6 * t - 15) + 10);
};

const SPRING_RATE_SETTLING_IN_A_THIRD_OF_A_SECOND = 16;
const LONGEST_SPRING_STEP = 0.064;

function springOneKey(x: number, v: number, h: number) {
  const decay = Math.exp(-SPRING_RATE_SETTLING_IN_A_THIRD_OF_A_SECOND * h);
  const c = v + SPRING_RATE_SETTLING_IN_A_THIRD_OF_A_SECOND * x;
  return { offset: (x + c * h) * decay, velocity: (v - SPRING_RATE_SETTLING_IN_A_THIRD_OF_A_SECOND * c * h) * decay };
}

function clampedKey(k: keyof Pose, value: number) {
  if (NEVER_BELOW_ZERO.has(k) && value < 0) return 0;
  if (NEVER_ABOVE_ONE.has(k) && value > 1) return 1;
  return value;
}

function settledKey(k: keyof Pose, value: number, velocity: number, target: number): [number, number] {
  const clamped = clampedKey(k, value);
  const clampedVelocity = clamped === value ? velocity : 0;
  if (Math.abs(clamped - target) < 5e-4 && Math.abs(clampedVelocity) < 5e-3) return [target, 0];
  return [clamped, clampedVelocity];
}

function criticallyDampedSpring(from: Pose, to: Pose, vel: Partial<Pose>, dt: number): Pose {
  const out = { ...to };
  const h = Math.min(dt, LONGEST_SPRING_STEP);
  for (const k of KEYS) {
    const { offset, velocity } = springOneKey(from[k] - to[k], vel[k] ?? 0, h);
    const [value, settledVelocity] = settledKey(k, to[k] + offset, velocity, to[k]);
    out[k] = value;
    vel[k] = settledVelocity;
  }
  return out;
}

export type Life = ReturnType<typeof createLife>;

export function createLife(seed: number, expression: Expression) {
  const r = seededUniform(seed);
  const vel: Partial<Pose> = {};
  const origin: Point = [0, 0];
  const gaze: Point = [0, 0];
  const stillDrift: DriftOffsets = [0, 0, 0];
  return {
    r,
    expression,
    since: 0,
    pose: { ...POSES[expression] },
    vel,
    swayPhase: r() * Math.PI * 2,
    time: 0,
    blink: { wait: 0.4 + 4.4 * r(), elapsed: 0, duration: 0.18, on: false, second: false },
    wander: { from: origin, to: origin, point: origin, elapsed: 0, travel: 0.2, hold: 0.4 + 1.3 * r() },
    drift: { from: stillDrift, to: stillDrift, elapsed: 0, duration: 2.2 },
    gaze,
    readingAlongLine: 0,
    intoTurn: 0,
    nudge: 1.5 + 2 * r(),
  };
}

function unevenBlink(b: Life["blink"], r: () => number, dt: number) {
  if (!b.on) {
    b.wait -= dt;
    if (b.wait > 0) return 1;
    b.on = true;
    b.elapsed = 0;
    b.duration = 0.14 + 0.09 * r();
  }
  b.elapsed += dt;
  const a = b.elapsed / b.duration;
  if (a >= 1) {
    b.on = false;
    b.second = !b.second && r() < 0.12;
    b.wait = b.second ? 0.14 + 0.12 * r() : 2.1 + 5.2 * r();
    return 1;
  }
  return Math.max(0.07, 1 - Math.sin(Math.PI * a) ** 2);
}

function nextWanderPoint(from: Point, r: () => number): Point {
  const nearTheMiddle = r() < 0.24 ? 0.2 : 1;
  let next = from;
  for (let i = 0; i < 4; i++) {
    next = [(2 * r() - 1) * nearTheMiddle, (2 * r() - 1) * nearTheMiddle];
    if (Math.hypot(next[0] - from[0], next[1] - from[1]) > 0.3) return next;
  }
  return next;
}

function wanderingSaccades(w: Life["wander"], r: () => number, dt: number, box: LookBox): Point {
  w.elapsed += dt;
  while (w.elapsed >= w.travel + w.hold) {
    w.elapsed -= w.travel + w.hold;
    w.from = w.to;
    const next = nextWanderPoint(w.from, r);
    const [x0, y0, x1, y1] = box;
    w.to = [x0 + ((next[0] + 1) / 2) * (x1 - x0), y0 + ((next[1] + 1) / 2) * (y1 - y0)];
    w.travel = 0.16 + 0.3 * r();
    w.hold = r() < 0.2 ? 0.25 + 0.45 * r() : 1 + 2.6 * r();
  }
  const t = smooth(Math.min(w.elapsed / w.travel, 1));
  w.point = [w.from[0] + (w.to[0] - w.from[0]) * t, w.from[1] + (w.to[1] - w.from[1]) * t];
  return w.point;
}

function heldExpressionDrift(d: Life["drift"], r: () => number, dt: number): DriftOffsets {
  d.elapsed += dt;
  while (d.elapsed >= d.duration) {
    d.elapsed -= d.duration;
    d.from = d.to;
    d.to = [(r() - 0.5) * 0.18, (r() - 0.5) * 0.22, (r() - 0.5) * 0.07];
    d.duration = 1.8 + 1.8 * r();
  }
  const t = smooth(d.elapsed / d.duration);
  const [open, asymmetry, tilt] = d.from;
  return [open + (d.to[0] - open) * t, asymmetry + (d.to[1] - asymmetry) * t, tilt + (d.to[2] - tilt) * t];
}

export type Frame = Pose & { blink: number; gx: number; gy: number; x: number; y: number; rot: number; scale: number; z: number; turn: number };

export const restFrame = (e: Expression): Frame => ({ ...POSES[e], blink: 1, gx: POSES[e].lookX, gy: POSES[e].lookY, x: 0, y: 0, rot: POSES[e].tilt, scale: 1, z: 0, turn: 0 });

const SPIN_TURN = 1.15;
const SPIN_BEAT = 1.6;
const SACCADE_LAG = 0.085;

type Head = { x: number; y: number; rot: number; scale: number; z: number; turn: number };

const isTurningState = (e: Expression) => e === "working" || e === "thinking";

function readingSweep(l: Life, dt: number): Point {
  l.readingAlongLine = (l.readingAlongLine + dt / 1.3) % 1;
  const s = l.readingAlongLine;
  const across = s < 0.85 ? -0.7 + 1.4 * smooth(s / 0.85) : 0.7 - 1.4 * smooth((s - 0.85) / 0.15);
  return [across, 0.15 * Math.sin(l.time * 0.7)];
}

function lookTarget(l: Life, dt: number): Point {
  switch (l.expression) {
    case "working": {
      return readingSweep(l, dt);
    }
    case "thinking": {
      return wanderingSaccades(l.wander, l.r, dt, [-0.3, -0.9, 0.9, -0.2]);
    }
    case "waiting": {
      return wanderingSaccades(l.wander, l.r, dt, [-0.25, -0.2, 0.25, 0.2]);
    }
    case "asleep": {
      return [0, 0];
    }
    case "idle":
    case "done":
    case "error": {
      return wanderingSaccades(l.wander, l.r, dt, [-1, -0.8, 1, 0.8]);
    }
  }
}

function chaseGaze(l: Life, p: Pose, look: Point, dt: number) {
  const k = 1 - Math.exp(-dt / SACCADE_LAG);
  l.gaze = [l.gaze[0] + (look[0] * 0.55 + p.lookX - l.gaze[0]) * k, l.gaze[1] + (look[1] * 0.45 + p.lookY - l.gaze[1]) * k];
}

function hopThenDip(t: number) {
  const hop = t < 0.18 ? Math.sin((Math.PI * t) / 0.18) ** 2 * 0.32 : 0;
  return hop - 1.45 * Math.sin(Math.PI * smoother((t - 0.12) / 0.72)) ** 2;
}

function turnAroundEachBeat(l: Life, head: Head, dt: number) {
  const isTurning = isTurningState(l.expression);
  if (!isTurning && l.intoTurn <= 0) return;
  l.intoTurn += dt;
  if (l.intoTurn >= SPIN_BEAT) l.intoTurn = isTurning ? l.intoTurn % SPIN_BEAT : 0;
  const t = Math.min(1, l.intoTurn / SPIN_TURN);
  if (l.intoTurn < SPIN_TURN) {
    head.turn = smoother((t - 0.08) / 0.84) * Math.PI * 2;
    head.y += hopThenDip(t);
    head.rot += -0.055 * Math.sin(head.turn);
  } else if (!isTurning) l.intoTurn = 0;
}

const CELEBRATION_SECONDS = 1.35;

function celebrateWithHops(l: Life, p: Pose, head: Head) {
  if (l.expression !== "done" || l.since >= CELEBRATION_SECONDS) return;
  head.y -= Math.abs(Math.sin((Math.PI * l.since) / 0.45)) * 1.3 * p.bounce * (1 - l.since / CELEBRATION_SECONDS);
}

function nudgeAboutToSpeak(l: Life, head: Head, dt: number) {
  if (l.expression !== "waiting") return;
  l.nudge -= dt;
  if (l.nudge < -0.7) l.nudge = 2.6 + 2.4 * l.r();
  if (l.nudge >= 0) return;
  const t = -l.nudge / 0.7;
  head.y -= Math.sin(Math.PI * t) ** 2 * 1.1;
  head.rot -= Math.sin(Math.PI * t) * 0.05;
}

function breatheAndDoze(l: Life, head: Head) {
  if (l.expression !== "asleep") return;
  const a = l.swayPhase;
  head.scale = 1 + Math.sin(a) * 0.035;
  head.y = -Math.sin(a) * 0.4;
  head.z = (l.time / 3.2) % 1;
}

function swayAndBob(l: Life, p: Pose, dt: number): Head {
  const cycleSeconds = l.expression === "asleep" ? 4.8 : 8;
  l.swayPhase = (l.swayPhase + (dt * Math.PI * 2) / cycleSeconds) % (Math.PI * 2);
  const a = l.swayPhase;
  return { x: Math.sin(a * 23) * p.tremble * 0.3, y: Math.sin(a) * 0.35, rot: p.tilt + Math.sin(a) * 0.03 + l.gaze[0] * 0.04, scale: 1 + Math.sin(a) * 0.006, z: 0, turn: 0 };
}

function driftedPose(l: Life, dt: number): Pose {
  const p = { ...l.pose };
  if (l.expression === "asleep") return p;
  const [open, asymmetry, tilt] = heldExpressionDrift(l.drift, l.r, dt);
  p.leftOpen *= 1 + open + asymmetry;
  p.rightOpen *= 1 + open - asymmetry;
  p.tilt += tilt;
  return p;
}

export function step(l: Life, target: Expression, dt: number): Frame {
  if (target !== l.expression) {
    l.expression = target;
    l.since = 0;
  }
  l.time += dt;
  l.since += dt;
  l.pose = criticallyDampedSpring(l.pose, POSES[l.expression], l.vel, dt);
  const p = driftedPose(l, dt);
  const blink = l.expression === "asleep" ? 1 : unevenBlink(l.blink, l.r, dt);
  chaseGaze(l, p, lookTarget(l, dt), dt);
  const head = swayAndBob(l, p, dt);
  turnAroundEachBeat(l, head, dt);
  celebrateWithHops(l, p, head);
  nudgeAboutToSpeak(l, head, dt);
  breatheAndDoze(l, head);
  return { ...p, blink, gx: l.gaze[0], gy: l.gaze[1], ...head };
}
