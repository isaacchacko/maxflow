# Agent faces and working marks: how BoardUI moves, and what yarn does

Taken apart with [rea](https://github.com/morluto/rea) (`rea inspect-web-page --include-script-sources`, `rea export-web-scripts`) on
boardui.com's Agent Creator, Agent Thinking, Composer Loader, Agent Progress, Skeleton and Spinner pages, in a headless Chrome of our
own, plus CDP `Animation.*` events for every CSS and Web Animation's timing and easing. These notes are the mechanics only. yarn's
faces keep their own bodies and drawing (`src/components/AgentFace.tsx`) and their own numbers (`src/components/face/rig.ts`).

## BoardUI's avatar

**Rendering.** A 200×200 canvas per avatar, scaled to the device pixel ratio (at most 2×). One `requestAnimationFrame` loop per
avatar draws a frame every 16ms while something is changing (an expression easing, a blink, a working beat) and every 32ms otherwise.
dt is capped at 64ms. An `IntersectionObserver` stops drawing off screen, `document.hidden` stops it in a background tab, and
`prefers-reduced-motion` (or motion 0) draws the resting pose once and starts no loop.

**A face is numbers.** `leftOpen, rightOpen, width, smile, leftAngle, rightAngle, brow, browAngle, browLift, browAsymmetry, lookX,
lookY, headTilt, bounce, tremble, blink`. Each of the 16 expressions is a partial override of the neutral set (neutral: open 1,
width .45, angles -.08). The expression slider (0–100) lerps neutral toward the expression.

| expression | what moves |
|---|---|
| happy | open .75, width .53, smile 1, bounce 1 |
| thinking | left open .7, right .42, brow .9 raised and asymmetric, look up-right, head tilt .15 |
| curious | left 1.15, right .68, brow raised and asymmetric, head tilt -.13 |
| worried | open 1.1, narrow, brows -.85 (inner ends up), tremble .18 |
| focused | open .32, wide, brows lowered .4 |
| sleepy | open .18, wide, look down, tilt .12; "idle" goes to .10/.13 and draws z's |
| shook | open 1.55, brows way up, tremble 1 |

**Expression transitions.** Every number follows a critically damped spring, solved exactly per frame: ω = 16/s, so a change settles
in about 0.3s with no overshoot. Openness, width, smile and brow clamp at 0; smile and brow clamp at 1. A value snaps to its target
within 5e-4 at a speed under 5e-3. Because every expression is the same eye shape with different numbers, the eyes **morph**
(a pill bends into a ^ as smile rises) instead of swapping.

**Eye shape.** A rounded rectangle traced as a contour of points; `smile` lerps each point toward a point on an arch
(`y - 0.6·h·(1 - (x/w)²)`), closing the eye into a ^. The eyes sit on a sphere of radius 86, rotated by the gaze and projected with
perspective `274 / (360 - z)`, so turning the gaze foreshortens the far eye and fades it near the limb.

**Blink.** First wait 0.4–4.8s. Each blink lasts 0.14–0.23s, with openness `max(.07, 1 - sin(πt)²)`. Afterwards, 12% of the time a
second blink follows after 0.14–0.26s; otherwise the next waits 2.1–7.3s. No blinking while asleep.

**Gaze ("wander").** A saccade to a new point, smoothstep, lasting 0.16–0.46s, then a hold of 1–3.6s (a fifth of the time a short
0.25–0.7s). A quarter of the targets fall near the centre (scale .2), and each tries 4 times to land more than .3 away. Gaze scales by
.68 in x and .62 in y, and by how wide the eyes are open. The eyes chase the gaze with `1 - exp(-dt/85ms)`.

**Attention drift.** Every 1.8–3.6s a new target (openness ±9%, asymmetry ±11%, tilt ±3.5%) is eased toward with smoothstep, so a
held expression never freezes. While smiling, the eyes also wobble on incommensurate sines (1.65, 1.13, 1.48, 2.05 rad/s).

**Head.** A phase advances 2π per `duration` (8s by default). From it:
- y bob `sin(a)·motion/28`;
- rotation `sin(a)·motion/2400`;
- scale `1 + sin(a)·motion/4000`;
- bounce `-cos(2a)·bounce·motion/12`;
- tremble x `sin(23a)·tremble·motion/28`.

**Entrance (1s).**
- Scale .1 → 1 with ease-out cubic.
- y 46 → 0.
- A swing of `-22·sin(πt)(1-t)`.
- Rotation -.32 → 0 with smootherstep.
- Opacity over the first 0.2s; the face fades in from 0.15s to 0.55s.

**Working (1.15s per beat).**
- A hop: up `sin²` over the first 18%, then a dip of 9/200 under `sin²(π·smootherstep)`.
- A turn through 2π with smootherstep over 8–92%, and a tilt of `-.055·sin(turn)`.

**Asleep z's.** Four glyphs ("z", "Z" alternating) cycle on the phase. Each rises 44 and drifts right 15, with opacity
`.8·sin(πt)^1.5` and a growing size.

## BoardUI's working marks

| mark | mechanics |
|---|---|
| Thinking label shimmer | text-clipped gradient (tone 55% → tone → 55%), `background-size: 300%`, position 200% → -100%, **2.6s linear** loop |
| Progress label shimmer | secondary 16–38%, primary 50%, secondary 62–84%; **3.4s linear** |
| Dot wave / dot spin | 3×3 grid of 4px squares, gap 2. Phase steps 1/8 every 80ms; each dot's opacity is `.12 + .88·max(0, 1 - d/.3)^1.5`, where d is its distance behind the phase. Wave phase: `(col+row)/4·.75`. Spin phase: `atan2(row-1, col-1)/2π`. Opacity transitions over 220ms |
| Stars | five 4-point sparkles at set spots and sizes (1, .55, .45, .55, .4). Keyframes: 0/100% scale 0 opacity 0; 40% 1/1; 60% .8/.9. **1.4s ease-in-out**, each delayed by i·0.196s |
| Infinity comet | lemniscate path with `pathLength 100`, a dash of `11 89` over a 15% track, dashoffset to -100 in **1.2s linear** |
| Elapsed timer | mono, tabular, `4.9s`, updated every 100ms |
| Composer loader | gradient dashes (14 blurred copies) run around the composer's rounded rect; dashoffset 0 → -100, **4.5s linear**; it fades in over 450ms |
| Steps appearing (Agent Progress) | 450ms `cubic-bezier(.22,1,.36,1)`, staggered 160ms (650, 810, 970…) |
| Skeleton | a 600px sheen crossing in 1.9s linear; under reduced motion, a 2s opacity pulse to .55 |
| Spinner | 900ms linear rotation |
| Metal sweep (badges) | 9s linear rotation of a conic rim |

Reduced motion stops every one of them and leaves the static mark (labels in their tone, stars at .7).

## What yarn does

**One rig, our shapes.** `face/rig.ts` springs a pose (ω 16, the same exact solution). It runs:
- the blink scheduler (2–7s, 12% doubles);
- wander;
- drift;
- an 8s sway and bob.

`AgentFace` keeps our 14 SVG bodies. Its eyes are now one parametric path, a pill that bends into a ^ by `smile`, so every
expression morphs into the next.

**One loop for all faces.** A single shared `requestAnimationFrame` loop draws every living face, at 60fps while any is mid-change,
blinking or in a moving state, and at 30 otherwise. It writes SVG attributes directly, so there are no React renders per frame.
It draws nothing:
- while the tab is hidden;
- while `data-viewing` is set (the image viewer's scrim);
- for a face scrolled out of view (IntersectionObserver).

Reduced motion draws the resting pose. Lists of many faces (avatars in the inbox and in messages, the routing map) pass `still` and
draw the resting pose with no loop.

**States.**

| state | face | motion |
|---|---|---|
| idle | neutral | blinks, wanders anywhere, drifts, sways |
| working | narrowed, level, brows low | reads: a sweep left to right in 1.1s and a quick return; every 3–6s a page-turn hop (up, then a soft dip, a slight turn) |
| thinking | one eye narrowed under a raised brow, head tilted | gaze wanders in the upper right |
| waiting (on Isaac) | wide, brows up | gaze held near centre (at him); every 2.6–5s a nudge: a lift and lean |
| done | ^ ^ | three hops, each lower, over 1.35s as it lands, then rests smiling |
| error | worried brows, wide narrow eyes | a small tremble |
| asleep | lines, head tilted | no blinks; breathes on a 4.8s cycle; z's rise and fade |

**Working marks** (`src/components/Working.tsx`).
- `Working`: the iridescent ring.
- `Dots`: the wave, or the spin with `spin`.
- `Sparkles`.
- `Comet`.
- `Elapsed`: counts in seconds, then minutes and seconds, then hours and minutes.
- The `.shimmer` class.

Where they're used:
- **Thread pending line** (also the inbox's replies line): the router's face working, the shimmering status, and the elapsed time.
- **Sidebar pins**: each pin has its own face, seeded by the thread id so pins under one router differ. The face shows the thread's
  state:
  - router working → working;
  - an ask → waiting;
  - stopped without answering → error;
  - paused → asleep;
  - resolved → done;
  - otherwise idle.

  An unread pin keeps its dot, and a working pin shows the dots beside its title.
- **Agent page**: the header face follows the agent's state, and the terminal's working line uses the spinning dots with a
  shimmer.
