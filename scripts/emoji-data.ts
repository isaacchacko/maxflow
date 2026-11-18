// Builds src/lib/emoji-data.json, the emoji table chats render and pick from, out of emoji-datasource (the data Slack's shortcodes
// come from). Run with the package's emoji.json:  npm pack emoji-datasource && tar xzf emoji-datasource-*.tgz
//   bun scripts/emoji-data.ts package/emoji.json
// Each row is [emoji, "shortcode aliases", category, "lowercase name", tones?]: tones holds the five skin-tone variants (Slack's
// ::skin-tone-2:: to ::skin-tone-6::) when the emoji has them.
type Row = { unified: string; name: string | null; short_names: string[]; category: string; sort_order: number; skin_variations?: Record<string, { unified: string }> };
const ORDER = ["Smileys & Emotion", "People & Body", "Animals & Nature", "Food & Drink", "Travel & Places", "Activities", "Objects", "Symbols", "Flags"];
const TONES = ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"];
const char = (unified: string) => String.fromCodePoint(...unified.split("-").map(h => parseInt(h, 16)));
const rows = (JSON.parse(await Bun.file(process.argv[2]!).text()) as Row[])
  .filter(r => ORDER.includes(r.category))
  .sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.sort_order - b.sort_order)
  .map(r => {
    const tones = r.skin_variations && TONES.every(t => r.skin_variations![t]) ? TONES.map(t => char(r.skin_variations![t]!.unified)) : undefined;
    return [char(r.unified), r.short_names.join(" "), ORDER.indexOf(r.category), (r.name ?? r.short_names[0]!).toLowerCase(), ...(tones ? [tones.join(" ")] : [])];
  });
await Bun.write(new URL("../src/lib/emoji-data.json", import.meta.url), JSON.stringify({ categories: ORDER, rows }));
console.log(`${rows.length} emoji, ${rows.reduce((n, r) => n + String(r[1]).split(" ").length, 0)} shortcodes`);
