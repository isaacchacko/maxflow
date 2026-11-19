type Variant = { unified: string };
type SourceEmoji = { unified: string; name: string | null; short_names: string[]; category: string; sort_order: number; skin_variations?: Record<string, Variant> };
type EmojiRow = [emoji: string, shortcodeAliases: string, category: number, lowercaseName: string, ...fiveSkinTones: string[]];

const USAGE = "Builds src/lib/emoji-data.json from emoji-datasource's emoji.json: npm pack emoji-datasource && tar xzf emoji-datasource-*.tgz && bun scripts/emoji-data.ts package/emoji.json";
const ORDER = ["Smileys & Emotion", "People & Body", "Animals & Nature", "Food & Drink", "Travel & Places", "Activities", "Objects", "Symbols", "Flags"];
const SLACK_SKIN_TONES_2_TO_6 = ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"];

const char = (unified: string) => String.fromCodePoint(...unified.split("-").map((h) => Number.parseInt(h, 16)));

function byCategoryThenSortOrder(a: SourceEmoji, b: SourceEmoji) {
  const byCategory = ORDER.indexOf(a.category) - ORDER.indexOf(b.category);
  return byCategory === 0 ? a.sort_order - b.sort_order : byCategory;
}

function skinTonesOf(emoji: SourceEmoji): string[] {
  const variants = SLACK_SKIN_TONES_2_TO_6.map((tone) => emoji.skin_variations?.[tone]);
  if (!variants.every((variant): variant is Variant => variant !== undefined)) return [];
  return [variants.map((variant) => char(variant.unified)).join(" ")];
}

function rowOf(emoji: SourceEmoji): EmojiRow {
  const lowercaseName = (emoji.name ?? emoji.short_names[0] ?? "").toLowerCase();
  return [char(emoji.unified), emoji.short_names.join(" "), ORDER.indexOf(emoji.category), lowercaseName, ...skinTonesOf(emoji)];
}

const emojiJsonPath = process.argv[2];
if (emojiJsonPath === undefined) {
  console.error(USAGE);
  process.exit(1);
}
const rows = (JSON.parse(await Bun.file(emojiJsonPath).text()) as SourceEmoji[])
  .filter((emoji) => ORDER.includes(emoji.category))
  .toSorted(byCategoryThenSortOrder)
  .map((emoji) => rowOf(emoji));
await Bun.write(new URL("../src/lib/emoji-data.json", import.meta.url), JSON.stringify({ categories: ORDER, rows }));
console.log(`${rows.length} emoji, ${rows.reduce((n, row) => n + row[1].split(" ").length, 0)} shortcodes`);
