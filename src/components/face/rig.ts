// The motion behind an agent's face, after BoardUI's Agent Creator (its mechanics written down in docs/face-motion.md; the
// numbers here are ours). A face is a set of numbers (how open each eye is, its width and angle, how far it smiles, the brows,
// where it looks, how the head tilts, bounces and trembles); an expression is a target for them, and each frame the numbers
// spring toward it, so the eyes morph from one expression into the next instead of swapping. On top of that, life: blinks at
// uneven intervals (sometimes twice), the gaze wandering and holding, small drifts of openness and tilt, a slow sway, and what
// each state does on its own (scanning while working, glancing up while thinking, nudging while waiting on Isaac, breathing and
// dozing while asleep).

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

const NEUTRAL: Pose = { leftOpen: 1, rightOpen: 1, width: 1, smile: 0, leftAngle: 0, rightAngle: 0, brow: 0, browAngle: 0, browLift: 0, browAsym: 0, lookX: 0, lookY: 0, tilt: 0, bounce: 0, tremble: 0 };

// lookX/lookY are in eye units (about an eye's width); angles in radians; tilt is the head's.
export const POSES: Record<Expression, Pose> = {
  idle: NEUTRAL,
  // Up and to the side, one eye narrowed under a raised brow.
  thinking: { ...NEUTRAL, leftOpen: 0.78, rightOpen: 0.5, brow: 0.9, browAngle: -0.1, browLift: 0.6, browAsym: 1, lookX: 0.5, lookY: -0.65, tilt: 0.12 },
  // Narrowed and level, reading down the page.
  working: { ...NEUTRAL, leftOpen: 0.46, rightOpen: 0.46, width: 1.25, leftAngle: 0.08, rightAngle: -0.08, brow: 0.45, browAngle: 0.12, browLift: -0.4, lookY: 0.25 },
  // Wide, brows up, looking out at him.
  waiting: { ...NEUTRAL, leftOpen: 1.16, rightOpen: 1.16, width: 0.95, brow: 0.85, browAngle: -0.25, browLift: 0.9, tilt: -0.1, lookY: -0.1 },
  done: { ...NEUTRAL, leftOpen: 0.8, rightOpen: 0.8, width: 1.4, smile: 1, bounce: 1 },
  error: { ...NEUTRAL, leftOpen: 1.08, rightOpen: 1.08, width: 0.78, brow: 1, browAngle: -0.75, browLift: 0.5, lookY: 0.35, tremble: 0.35 },
  asleep: { ...NEUTRAL, leftOpen: 0.12, rightOpen: 0.15, width: 1.22, leftAngle: 0.08, rightAngle: -0.08, lookY: 0.5, tilt: 0.1 },
};

const KEYS = Object.keys(NEUTRAL) as (keyof Pose)[];
const CLAMP0 = new Set<keyof Pose>(["leftOpen", "rightOpen", "width", "bounce", "tremble", "smile", "brow"]);

/** A seeded uniform in [0, 1): a face keeps its own rhythm. */
export const rng = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 2 ** 32);
};
const smooth = (t: number) => t * t * (3 - 2 * t);
const smoother = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (6 * t - 15) + 10);
};

/**
 * One step of a critically damped spring from `from` toward `to`, keeping velocity in `vel` (ω = 16/s: an expression settles in
 * about a third of a second, with no overshoot).
 */
function spring(from: Pose, to: Pose, vel: Partial<Pose>, dt: number): Pose {
  const out = { ...to };
  const h = Math.min(dt, 0.064);
  const e = Math.exp(-16 * h);
  for (const k of KEYS) {
    const x = from[k] - to[k];
    const v = vel[k] ?? 0;
    const c = v + 16 * x;
    let p = to[k] + (x + c * h) * e;
    let nv = (v - 16 * c * h) * e;
    if (CLAMP0.has(k) && p < 0) (p = 0), (nv = 0);
    if ((k === "smile" || k === "brow") && p > 1) (p = 1), (nv = 0);
    if (Math.abs(p - to[k]) < 5e-4 && Math.abs(nv) < 5e-3) (p = to[k]), (nv = 0);
    out[k] = p;
    vel[k] = nv;
  }
  return out;
}

/** The state a living face keeps between frames. */
export type Life = ReturnType<typeof createLife>;

export function createLife(seed: number, expression: Expression) {
  const r = rng(seed);
  return {
    r,
    expression,
    since: 0,
    pose: { ...POSES[expression] },
    vel: {} as Partial<Pose>,
    // A slow cycle for sway and bob, started somewhere of its own.
    phase: r() * Math.PI * 2,
    time: 0,
    blink: { wait: 0.4 + 4.4 * r(), elapsed: 0, duration: 0.18, on: false, second: false },
    wander: { from: [0, 0], to: [0, 0], point: [0, 0], elapsed: 0, travel: 0.2, hold: 0.4 + 1.3 * r() },
    drift: { from: [0, 0, 0], to: [0, 0, 0], elapsed: 0, duration: 2.2 },
    gaze: [0, 0] as [number, number],
    // While working: where the eyes are along the line they read, and how far into a turn the body is.
    scan: 0,
    spin: 0,
    nudge: 1.5 + 2 * r(),
  };
}

/** Blinks at uneven intervals of 2–7s, each 0.14–0.23s, and one time in eight a second blink right after. */
function blink(b: Life["blink"], r: () => number, dt: number) {
  if (!b.on) {
    if ((b.wait -= dt) > 0) return 1;
    (b.on = true), (b.elapsed = 0), (b.duration = 0.14 + 0.09 * r());
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

/**
 * Where the eyes wander: a quick saccade (0.16–0.46s, smoothstep) to a new point, then a hold (1–3.6s, sometimes a short 0.25–0.7s);
 * a quarter of the time the point is near the middle. `box` limits where it may go ([x0, y0, x1, y1] in -1..1).
 */
function wander(w: Life["wander"], r: () => number, dt: number, box: [number, number, number, number]) {
  w.elapsed += dt;
  while (w.elapsed >= w.travel + w.hold) {
    w.elapsed -= w.travel + w.hold;
    w.from = w.to;
    const near = r() < 0.24 ? 0.2 : 1;
    let next = w.from;
    for (let i = 0; i < 4; i++) {
      next = [(2 * r() - 1) * near, (2 * r() - 1) * near];
      if (Math.hypot(next[0]! - w.from[0]!, next[1]! - w.from[1]!) > 0.3) break;
    }
    const [x0, y0, x1, y1] = box;
    w.to = [x0 + ((next[0]! + 1) / 2) * (x1 - x0), y0 + ((next[1]! + 1) / 2) * (y1 - y0)];
    w.travel = 0.16 + 0.3 * r();
    w.hold = r() < 0.2 ? 0.25 + 0.45 * r() : 1 + 2.6 * r();
  }
  const t = smooth(Math.min(w.elapsed / w.travel, 1));
  w.point = [w.from[0]! + (w.to[0]! - w.from[0]!) * t, w.from[1]! + (w.to[1]! - w.from[1]!) * t];
  return w.point as [number, number];
}

/** Small drifts of openness, asymmetry and tilt, eased from one to the next every 1.8–3.6s, so a held expression never freezes. */
function drift(d: Life["drift"], r: () => number, dt: number) {
  d.elapsed += dt;
  while (d.elapsed >= d.duration) {
    d.elapsed -= d.duration;
    d.from = d.to;
    d.to = [(r() - 0.5) * 0.18, (r() - 0.5) * 0.22, (r() - 0.5) * 0.07];
    d.duration = 1.8 + 1.8 * r();
  }
  const t = smooth(d.elapsed / d.duration);
  return d.from.map((f, i) => f + (d.to[i]! - f) * t) as [number, number, number];
}

/** What the face draws this frame: the pose, plus the motion that isn't part of the expression. */
export type Frame = Pose & { blink: number; gx: number; gy: number; x: number; y: number; rot: number; scale: number; z: number; turn: number };

/** The pose an expression holds, with no life in it: the still face, and the first frame of a living one. */
export const restFrame = (e: Expression): Frame => ({ ...POSES[e], blink: 1, gx: POSES[e].lookX, gy: POSES[e].lookY, x: 0, y: 0, rot: POSES[e].tilt, scale: 1, z: 0, turn: 0 });

const SPIN_TURN = 1.15;
const SPIN_BEAT = 1.6;

export function step(l: Life, target: Expression, dt: number): Frame {
  if (target !== l.expression) (l.expression = target), (l.since = 0);
  l.time += dt;
  l.since += dt;
  const e = l.expression;
  const goal = POSES[e];
  l.pose = spring(l.pose, goal, l.vel, dt);
  const p = { ...l.pose };

  // The held expression drifts a little.
  if (e !== "asleep") {
    const [open, asym, tilt] = drift(l.drift, l.r, dt);
    p.leftOpen *= 1 + open + asym;
    p.rightOpen *= 1 + open - asym;
    p.tilt += tilt;
  }
  const b = e === "asleep" ? 1 : blink(l.blink, l.r, dt);

  // Where it looks, by state.
  let look: [number, number];
  if (e === "working") {
    // Reads: a sweep left to right over 1.1s, a quick return, and now and then a glance up.
    l.scan = (l.scan + dt / 1.3) % 1;
    const s = l.scan < 0.85 ? -0.7 + 1.4 * smooth(l.scan / 0.85) : 0.7 - 1.4 * smooth((l.scan - 0.85) / 0.15);
    look = [s, 0.15 * Math.sin(l.time * 0.7)];
  } else if (e === "thinking") look = wander(l.wander, l.r, dt, [-0.3, -0.9, 0.9, -0.2]);
  else if (e === "waiting") look = wander(l.wander, l.r, dt, [-0.25, -0.2, 0.25, 0.2]);
  else if (e === "asleep") look = [0, 0];
  else look = wander(l.wander, l.r, dt, [-1, -0.8, 1, 0.8]);
  // The eyes chase their target with a short lag (85ms), so a saccade has weight.
  const k = 1 - Math.exp(-dt / 0.085);
  l.gaze = [l.gaze[0] + (look[0] * 0.55 + p.lookX - l.gaze[0]) * k, l.gaze[1] + (look[1] * 0.45 + p.lookY - l.gaze[1]) * k];

  // The head: a slow sway and bob on an 8s cycle, the expression's bounce and tremble, and the state's own beat.
  l.phase = (l.phase + (dt * Math.PI * 2) / (e === "asleep" ? 4.8 : 8)) % (Math.PI * 2);
  const a = l.phase;
  let y = Math.sin(a) * 0.35;
  let x = Math.sin(a * 23) * p.tremble * 0.3;
  let rot = p.tilt + Math.sin(a) * 0.03 + l.gaze[0] * 0.04;
  let scale = 1 + Math.sin(a) * 0.006;
  let z = 0;
  // Working or thinking, the body turns all the way round about its vertical axis, as BoardUI's does while it processes: each
  // beat a 1.15s turn (smootherstep, holding face-on for 8% at either end) with a small hop and a lean into it, then 0.45s
  // face-on before the next. A turn under way when the state changes finishes rather than snapping back.
  let turn = 0;
  if (e === "working" || e === "thinking" || l.spin > 0) {
    l.spin += dt;
    if (l.spin >= SPIN_BEAT) l.spin = e === "working" || e === "thinking" ? l.spin % SPIN_BEAT : 0;
    const t = Math.min(1, l.spin / SPIN_TURN);
    if (l.spin < SPIN_TURN) {
      turn = smoother((t - 0.08) / 0.84) * Math.PI * 2;
      y += (t < 0.18 ? Math.sin((Math.PI * t) / 0.18) ** 2 * 0.32 : 0) - 1.45 * Math.sin(Math.PI * smoother((t - 0.12) / 0.72)) ** 2;
      rot += -0.055 * Math.sin(turn);
    } else if (e !== "working" && e !== "thinking") l.spin = 0;
  }
  if (e === "done" && l.since < 1.35) {
    // Done celebrates: three hops, each lower, when it lands, then it rests in its smile.
    y -= Math.abs(Math.sin((Math.PI * l.since) / 0.45)) * 1.3 * p.bounce * (1 - l.since / 1.35);
  }
  if (e === "waiting") {
    // A nudge every few seconds: a little lift and lean toward him, as if about to speak.
    l.nudge -= dt;
    if (l.nudge < -0.7) l.nudge = 2.6 + 2.4 * l.r();
    if (l.nudge < 0) {
      const t = -l.nudge / 0.7;
      y -= Math.sin(Math.PI * t) ** 2 * 1.1;
      rot -= Math.sin(Math.PI * t) * 0.05;
    }
  }
  if (e === "asleep") {
    scale = 1 + Math.sin(a) * 0.035;
    y = -Math.sin(a) * 0.4;
    z = (l.time / 3.2) % 1;
  }
  return { ...p, blink: b, gx: l.gaze[0], gy: l.gaze[1], x, y, rot, scale, z, turn };
}
