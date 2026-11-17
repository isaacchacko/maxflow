import * as chrono from "chrono-node";

// Isaac's clock: what he types is read, and the time it lands on is drawn, in Pacific time whatever the machine's zone.
const ZONE = "America/Los_Angeles";

// His words chrono doesn't know, as the times he means by them.
const SAYINGS: [RegExp, string][] = [
  [/\bafter lunch\b/i, "1pm"],
  [/\blunch(time)?\b/i, "12pm"],
  [/\b(eod|end of (the )?day)\b/i, "5pm"],
  [/\b(eow|end of (the )?week)\b/i, "friday 5pm"],
  [/\bnext week\b/i, "next monday"],
];
// A time of day he named, even loosely: without one a day lands at 9 in the morning, as "monday" and "next week" mean.
const TIME_OF_DAY = /\b(morning|afternoon|evening|tonight|night|noon|midday|midnight)\b/i;

const read = (text: string, now: Date) => chrono.parse(text, { instant: now, timezone: "PT" }, { forwardDate: true })[0];

/** When "tomorrow 9am", "in 2h", "monday", "after lunch" or "next week" comes round, from now; undefined for nothing, or a time past. */
export function parseWhen(said: string, now = new Date()): Date | undefined {
  const text = SAYINGS.reduce((s, [re, to]) => s.replace(re, to), said.trim());
  const r = text && read(text, now);
  if (!r) return;
  let at = r.start.date();
  if (!r.start.isCertain("hour") && !TIME_OF_DAY.test(text)) {
    const day = `${r.start.get("month")}/${r.start.get("day")}/${r.start.get("year")}`;
    at = read(`${day} 9am`, now)?.start.date() ?? at;
  }
  // A weekday that is today ("monday", said on a Monday afternoon) means next week's.
  if (at <= now && r.start.isCertain("weekday") && !r.start.isCertain("day")) at = new Date(at.getTime() + 7 * 86_400_000);
  return at > now ? at : undefined;
}

/** "Tue Nov 17, 9:00 AM", in his zone; the year only when it isn't this one. */
export function formatWhen(at: Date | string | number, now = new Date()) {
  const d = new Date(at);
  const year = (x: Date) => x.toLocaleString("en-US", { timeZone: ZONE, year: "numeric" });
  const day = d.toLocaleString("en-US", { timeZone: ZONE, weekday: "short", month: "short", day: "numeric", ...(year(d) !== year(now) && { year: "numeric" }) });
  const time = d.toLocaleString("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" });
  return `${day.replace(",", "")}, ${time}`;
}

/** The quick picks, as words parseWhen reads. */
export const CHIPS = [
  { label: "in 1h", said: "in 1 hour" },
  { label: "this evening 6pm", said: "today 6pm" },
  { label: "tomorrow 9am", said: "tomorrow 9am" },
  { label: "next Monday 9am", said: "next monday 9am" },
];
