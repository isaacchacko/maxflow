import { hasText } from "@/lib/utils";
import { createStore } from "@/store";

// constraint: emoji-data.json is emoji-datasource's table (where Slack's shortcodes come from), built by scripts/emoji-data.ts
export type Emoji = { char: string; names: string[]; category: number; name: string; tones?: string[] | undefined };
type Table = { list: Emoji[]; byName: Map<string, Emoji>; categories: string[] };

const BEFORE_THE_TABLE_AND_SLACK_ONLY: Record<string, string> = {
  smile: "😄", joy: "😂", sweat_smile: "😅", slightly_smiling_face: "🙂", wink: "😉", thinking_face: "🤔", sob: "😭", eyes: "👀",
  pray: "🙏", clap: "👏", raised_hands: "🙌", wave: "👋", muscle: "💪", "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎",
  heart: "❤️", fire: "🔥", tada: "🎉", rocket: "🚀", sparkles: "✨", "100": "💯", white_check_mark: "✅", heavy_check_mark: "✔️",
  x: "❌", warning: "⚠️", rotating_light: "🚨", bulb: "💡", memo: "📝", pushpin: "📌", bug: "🐛", cat2: "🐈", yarn: "🧶",
  party_popper: "🎉", shrug: "🤷", face_palm: "🤦", thread: "🧵", simple_smile: "🙂",
};

export const emojiReady = createStore(false);
const loaded: { table: Table | undefined; loading: Promise<void> | undefined } = { table: undefined, loading: undefined };

async function readTable() {
  type Rows = { categories: string[]; rows: [string, string, number, string, string?][] };
  const { default: data } = await import("./emoji-data.json");
  const { categories, rows } = data as Rows;
  const list = rows.map(([char, names, category, name, tones]) => ({ char, names: names.split(" "), category, name, tones: tones?.split(" ") }));
  loaded.table = { list, categories, byName: new Map(list.flatMap(e => e.names.map(n => [n, e] as const))) };
  emojiReady.set(true);
}

export async function loadEmoji() {
  loaded.loading ??= readTable();
  return loaded.loading;
}
export const emojiTable = () => loaded.table;

export function emojiOf(code: string, skinTone?: number) {
  const e = loaded.table?.byName.get(code);
  if (!e) return BEFORE_THE_TABLE_AND_SLACK_ONLY[code];
  const toned = skinTone === undefined || skinTone === 0 ? undefined : e.tones?.[skinTone - 2];
  return hasText(toned) ? toned : e.char;
}

export const SHORTCODE = /:([a-z0-9_+'-]+):(?::skin-tone-([2-6]):)?/gi;
export const shortcodes = (text: string) => (text.includes(":") ? text.replaceAll(SHORTCODE, (all, code: string, tone?: string) => emojiOf(code.toLowerCase(), hasText(tone) ? Number(tone) : undefined) ?? all) : text);

const isCodeSpan = (i: number) => i % 2 === 1;
export const emojify = (markdown: string) =>
  markdown.includes(":") ? markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g).map((part, i) => (isCodeSpan(i) ? part : shortcodes(part))).join("") : markdown;

export function searchEmojiIn(table: Table | undefined, query: string, limit = 50): Emoji[] {
  const q = query.toLowerCase().replace(/^:/, "");
  if (!table || !q) return [];
  const starts: Emoji[] = [], within: Emoji[] = [];
  for (const e of table.list) {
    if (e.names.some(n => n.startsWith(q))) starts.push(e);
    else if (e.names.some(n => n.includes(q)) || e.name.includes(q)) within.push(e);
  }
  const everyday = (e: Emoji) => (e.names.some(n => Object.hasOwn(BEFORE_THE_TABLE_AND_SLACK_ONLY, n)) ? 0 : 1);
  return [...starts.toSorted((a, b) => everyday(a) - everyday(b)), ...within].slice(0, limit);
}
export const searchEmoji = (query: string, limit = 50) => searchEmojiIn(loaded.table, query, limit);

const RECENTLY_PICKED = "emoji-recent";
export function recentEmoji(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTLY_PICKED) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((c: unknown) => typeof c === "string") : [];
  } catch {
    return [];
  }
}
export function usedEmoji(char: string) {
  try {
    localStorage.setItem(RECENTLY_PICKED, JSON.stringify([char, ...recentEmoji().filter(c => c !== char)].slice(0, 24)));
  } catch {
    // constraint: localStorage throws in a private window or on a full quota; the pick is then not remembered
  }
}
