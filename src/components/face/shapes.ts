export type Shape = { name: string; d: string; cy: number; spread: number; scale?: number; round?: number; brows?: false; smallZoom?: number; eyes?: [[number, number], [number, number]] };
const ROUND: Shape = { name: "round", d: "M16 4.4c6.8 0 11.6 4.2 11.6 11 0 7.2-4.8 12.2-11.6 12.2S4.4 22.6 4.4 15.4C4.4 8.6 9.2 4.4 16 4.4z", cy: 15.6, spread: 4.6 };
export const SHAPES: Shape[] = [
  ROUND,
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
  { name: "dryft", d: "M20.13 7.2C20.75 6.64 21.74 7.07 21.74 7.91V12.97C21.81 14.34 22.91 15.44 24.29 15.49H27.08C27.69 15.49 28.0 16.24 27.57 16.67L22.31 21.93C21.87 22.36 21.13 22.06 21.13 21.44V17.58C21.12 16.64 20.89 15.87 19.89 15.87C19.13 15.87 18.22 16.57 17.79 16.95L10.58 23.59C9.97 24.16 8.98 23.73 8.98 22.89V17.86C8.96 16.47 7.85 15.33 6.47 15.26H4.92C4.31 15.26 4.0 14.52 4.43 14.08L8.43 10.02C8.86 9.58 9.61 9.89 9.61 10.51V13.34C9.64 14.22 9.89 14.93 10.85 14.93C11.48 14.93 12.2 14.45 12.68 14.08L20.13 7.2Z", cy: 15.9, spread: 2.6, scale: 0.8, round: 1.8, brows: false, smallZoom: 1.26, eyes: [[13.4, 17.1], [17.4, 14.4]] },
];

const DEFAULT_HUE = 217;
const HUES = [DEFAULT_HUE, 192, 158, 96, 38, 18, 248, 270, 200];

export function hash(id: string) {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
}

export function faceOf(id: string) {
  const h = hash(id);
  return { shape: h % SHAPES.length, hue: HUES[(h >>> 4) % HUES.length] ?? DEFAULT_HUE, spread: 0.78 + ((h >>> 9) % 4) * 0.07, phase: (h >>> 13) % 1000 };
}

export const shapeFor = (id: string, name: string | undefined) => SHAPES.find(x => x.name === name) ?? SHAPES[faceOf(id).shape] ?? ROUND;
