const TZ = "America/Los_Angeles";
export const DAY_MS = 86_400_000;
const GMT_OFFSET = /GMT([+-])(\d\d):(\d\d)/;
const ISO_DAY = /^\d{4}-\d\d-\d\d$/;

function tzOffsetMs(at: number) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(new Date(at));
  const m = GMT_OFFSET.exec(parts.find((p) => p.type === "timeZoneName")?.value ?? "");
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

export function midnight(day: string) {
  const [y = NaN, m = NaN, d = NaN] = day.split("-", 3).map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return guess - tzOffsetMs(guess - tzOffsetMs(guess));
}

export const dayKey = (at: number) => new Date(at + tzOffsetMs(at)).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const lastDays = (n: number) => Array.from({ length: n }, (_, i) => dayKey(Date.now() - (n - 1 - i) * DAY_MS));

export type Week = { key: string; from: number; to: number; days: string[] };

export function mondayToSundayWeek(anyDay?: string): Week {
  const day = anyDay !== undefined && ISO_DAY.test(anyDay) ? anyDay : dayKey(Date.now());
  const monday = addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return { key: monday, from: midnight(monday), to: midnight(addDays(monday, 7)), days };
}
