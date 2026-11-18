import { createStore } from "@/store";

// Slack's emoji: every :shortcode: Slack knows (emoji-datasource's, the table Slack's come from, built into emoji-data.json by
// scripts/emoji-data.ts), with skin tones (:+1::skin-tone-3:). The table is fetched the first time a message or the picker needs
// it; until then the few shortcodes below render, and a message drawn before it came is drawn again once it has.
export type Emoji = { char: string; names: string[]; category: number; name: string; tones?: string[] };
type Table = { categories: string[]; rows: [string, string, number, string, string?][] };

// The ones that render before the table loads, and Slack's own names emoji-datasource lacks.
const EARLY: Record<string, string> = {
  smile: "😄", joy: "😂", sweat_smile: "😅", slightly_smiling_face: "🙂", wink: "😉", thinking_face: "🤔", sob: "😭", eyes: "👀",
  pray: "🙏", clap: "👏", raised_hands: "🙌", wave: "👋", muscle: "💪", "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎",
  heart: "❤️", fire: "🔥", tada: "🎉", rocket: "🚀", sparkles: "✨", "100": "💯", white_check_mark: "✅", heavy_check_mark: "✔️",
  x: "❌", warning: "⚠️", rotating_light: "🚨", bulb: "💡", memo: "📝", pushpin: "📌", bug: "🐛", cat2: "🐈", yarn: "🧶",
  party_popper: "🎉", shrug: "🤷", face_palm: "🤦", thread: "🧵", simple_smile: "🙂",
};

export const emojiReady = createStore(false);
let table: { list: Emoji[]; byName: Map<string, Emoji>; categories: string[] } | undefined;
let loading: Promise<void> | undefined;
export function loadEmoji() {
  return (loading ??= import("./emoji-data.json").then(({ default: t }) => {
    const { categories, rows } = t as Table;
    const list = rows.map(([char, names, category, name, tones]) => ({ char, names: names.split(" "), category, name, tones: tones?.split(" ") }));
    table = { list, categories, byName: new Map(list.flatMap(e => e.names.map(n => [n, e] as const))) };
    emojiReady.set(true);
  }));
}
export const emojiTable = () => table;

/** The emoji a shortcode names, in a skin tone (2 to 6, Slack's ::skin-tone-N::) when it has them; undefined for an unknown one. */
export function emojiOf(code: string, tone?: number) {
  const e = table?.byName.get(code);
  if (!e) return EARLY[code];
  return (tone && e.tones?.[tone - 2]) || e.char;
}

/** :shortcode: and :shortcode::skin-tone-N: as their emoji; an unknown one stays as typed. */
export const SHORTCODE = /:([a-z0-9_+'-]+):(?::skin-tone-([2-6]):)?/gi;
export const shortcodes = (text: string) => (text.includes(":") ? text.replace(SHORTCODE, (all, code: string, tone?: string) => emojiOf(code.toLowerCase(), tone ? Number(tone) : undefined) ?? all) : text);

/** The same over markdown, leaving code (fenced or inline) as written. */
export const emojify = (markdown: string) =>
  markdown.includes(":") ? markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g).map((part, i) => (i % 2 ? part : shortcodes(part))).join("") : markdown;

/**
 * Shortcodes for a query, as Slack's autocomplete ranks them: a name starting with it first (the everyday ones above, then the
 * rest), then one containing it.
 */
export function searchEmoji(query: string, limit = 50): Emoji[] {
  const q = query.toLowerCase().replace(/^:/, "");
  if (!table || !q) return [];
  const starts: Emoji[] = [], within: Emoji[] = [];
  for (const e of table.list) {
    if (e.names.some(n => n.startsWith(q))) starts.push(e);
    else if (e.names.some(n => n.includes(q)) || e.name.includes(q)) within.push(e);
  }
  const everyday = (e: Emoji) => (e.names.some(n => n in EARLY) ? 0 : 1);
  return [...starts.sort((a, b) => everyday(a) - everyday(b)), ...within].slice(0, limit);
}

// What he picked last, first in the picker.
const RECENT = "emoji-recent";
export function recentEmoji(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]");
  } catch {
    return [];
  }
}
export function usedEmoji(char: string) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([char, ...recentEmoji().filter(c => c !== char)].slice(0, 24)));
  } catch {}
}
