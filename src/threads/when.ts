import * as chrono from "chrono-node";

const ISAACS_ZONE = "America/Los_Angeles";

const PHRASES_CHRONO_MISSES: [RegExp, string][] = [
  [/\bafter lunch\b/i, "1pm"],
  [/\blunch(time)?\b/i, "12pm"],
  [/\b(eod|end of (the )?day)\b/i, "5pm"],
  [/\b(eow|end of (the )?week)\b/i, "friday 5pm"],
  [/\bnext week\b/i, "next monday"],
];
const LOOSE_TIME_OF_DAY = /\b(morning|afternoon|evening|tonight|night|noon|midday|midnight)\b/i;

const read = (text: string, now: Date) => chrono.parse(text, { instant: now, timezone: "PT" }, { forwardDate: true })[0];

export function parseWhen(said: string, now = new Date()): Date | undefined {
  const text = PHRASES_CHRONO_MISSES.reduce((s, [re, to]) => s.replace(re, () => to), said.trim());
  if (text === "") return;
  const r = read(text, now);
  if (!r) return;
  let at = r.start.date();
  const isDayWithoutTime = !r.start.isCertain("hour") && !LOOSE_TIME_OF_DAY.test(text);
  if (isDayWithoutTime) {
    const day = `${r.start.get("month")}/${r.start.get("day")}/${r.start.get("year")}`;
    at = read(`${day} 9am`, now)?.start.date() ?? at;
  }
  const isWeekdayThatIsToday = at <= now && r.start.isCertain("weekday") && !r.start.isCertain("day");
  if (isWeekdayThatIsToday) at = new Date(at.getTime() + 7 * 86_400_000);
  return at > now ? at : undefined;
}

export function formatWhen(at: Date | string | number, now = new Date()) {
  const d = new Date(at);
  const year = (x: Date) => x.toLocaleString("en-US", { timeZone: ISAACS_ZONE, year: "numeric" });
  const day = d.toLocaleString("en-US", { timeZone: ISAACS_ZONE, weekday: "short", month: "short", day: "numeric", ...(year(d) !== year(now) && { year: "numeric" }) });
  const time = d.toLocaleString("en-US", { timeZone: ISAACS_ZONE, hour: "numeric", minute: "2-digit" });
  return `${day.replace(",", "")}, ${time}`;
}

export const CHIPS = [
  { label: "in 1h", said: "in 1 hour" },
  { label: "this evening 6pm", said: "today 6pm" },
  { label: "tomorrow 9am", said: "tomorrow 9am" },
  { label: "next Monday 9am", said: "next monday 9am" },
];
