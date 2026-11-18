import { useEffect, useMemo, useRef, useState } from "react";
import { emojiReady, emojiTable, loadEmoji, recentEmoji, searchEmoji, usedEmoji, type Emoji } from "@/lib/emoji";
import { cn } from "@/lib/utils";
import { caretAt } from "./Mention";

// A category's mark on the picker's bar, in emoji-data.json's order.
const MARKS = ["😀", "👋", "🐈", "🍎", "✈️", "⚽", "💡", "❤️", "🏁"];

/**
 * Slack's emoji picker: every emoji Slack has, searched by shortcode or name, his recent ones first, then each category, with a bar
 * to jump between them; the one under the pointer shows its :shortcode: below. Its table is fetched when it first opens.
 */
export function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const ready = emojiReady.use();
  useEffect(() => void loadEmoji(), []);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<Emoji>();
  const grid = useRef<HTMLDivElement>(null);
  const table = emojiTable();
  const recent = useMemo(() => recentEmoji().flatMap(c => table?.list.find(e => e.char === c) ?? []), [ready]);
  const found = query.trim() ? searchEmoji(query.trim(), 300) : undefined;
  const pick = (e: Emoji) => (usedEmoji(e.char), onPick(e.char));
  const cell = (e: Emoji, key: string) => (
    <button key={key} type="button" title={`:${e.names[0]}:`} onMouseDown={ev => ev.preventDefault()} onMouseEnter={() => setHover(e)} onClick={() => pick(e)} className="flex size-8 items-center justify-center rounded-md text-xl hover:bg-muted">
      {e.char}
    </button>
  );
  const section = (title: string, list: Emoji[], id?: string) =>
    list.length > 0 && (
      <section key={title} data-section={id}>
        <h4 className="sticky top-0 z-10 bg-card px-1 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">{title}</h4>
        <div className="grid grid-cols-8">{list.map((e, i) => cell(e, `${title}-${i}`))}</div>
      </section>
    );
  return (
    <div data-agent="emoji-panel" className="flex w-80 flex-col">
      <input
        autoFocus
        data-agent="emoji-search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => e.key === "Enter" && found?.[0] && (e.preventDefault(), pick(found[0]))}
        placeholder="Search all emoji"
        className="m-2 mb-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring"
      />
      {!found && table && (
        <nav className="flex justify-between px-2 pb-1">
          {table.categories.map((c, i) => (
            <button key={c} type="button" title={c} onMouseDown={ev => ev.preventDefault()} onClick={() => grid.current?.querySelector(`[data-section="${i}"]`)?.scrollIntoView()} className="flex size-7 items-center justify-center rounded-md text-base opacity-70 hover:bg-muted hover:opacity-100">
              {MARKS[i]}
            </button>
          ))}
        </nav>
      )}
      <div ref={grid} className="h-64 overflow-y-auto px-1.5">
        {!table && <p className="p-3 text-xs text-muted-foreground">Loading emoji…</p>}
        {found ? (found.length ? section("Results", found) : <p className="p-3 text-xs text-muted-foreground">No emoji for “{query}”</p>) : table && [section("Recent", recent), ...table.categories.map((c, i) => section(c, table.list.filter(e => e.category === i), String(i)))]}
      </div>
      <p className="flex h-8 items-center gap-2 border-t px-3 text-xs text-muted-foreground">
        {hover && (
          <>
            <span className="text-base">{hover.char}</span>
            <span className="truncate">:{hover.names.join(": :")}:</span>
          </>
        )}
      </p>
    </div>
  );
}

// ":" then two characters of a shortcode, at the caret, after a space or the start, as Slack opens its autocomplete.
const COLON = /(?:^|\s):([a-z0-9_+'-]{2,40})$/i;

/** Slack's :shortcode autocomplete in a message box: the composer's keys go to it first while it is open, as the @ picker's do. */
export function useEmojiComplete(input: React.RefObject<HTMLTextAreaElement | null>, draft: string, setDraft: (text: string) => void) {
  const ready = emojiReady.use();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(-1);
  const typed = draft.slice(0, caret).match(COLON);
  const query = typed?.[1] ?? "";
  const start = typed ? caret - query.length - 1 : -1;
  useEffect(() => void (start >= 0 && loadEmoji()), [start >= 0]);
  const shown = useMemo(() => (start >= 0 ? searchEmoji(query, 8) : []), [query, start, ready]);
  const open = start >= 0 && start !== dismissed && shown.length > 0;
  useEffect(() => setActive(0), [query, start]);
  useEffect(() => void (start < 0 && setDismissed(-1)), [start]);

  function pick(e: Emoji | undefined) {
    const el = input.current;
    if (!e || !el) return;
    usedEmoji(e.char);
    setDraft(draft.slice(0, start) + e.char + " " + draft.slice(caret));
    const at = start + e.char.length + 1;
    requestAnimationFrame(() => (el.focus(), el.setSelectionRange(at, at), setCaret(at)));
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return false;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setActive(a => Math.min(shown.length - 1, a + 1));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setActive(a => Math.max(0, a - 1));
    else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) pick(shown[active]);
    else if (e.key === "Escape") setDismissed(start);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  const track = () => setCaret(input.current?.selectionStart ?? 0);
  const el = input.current;
  const at = open && el ? caretAt(el, start) : undefined;
  const below = !!(at && el && el.getBoundingClientRect().top + at.top < 320);
  const panel = at && (
    <div
      data-agent="emoji-complete"
      onMouseDown={e => e.preventDefault()}
      style={{ left: Math.min(at.left, (el?.clientWidth ?? 0) - 288), ...(below ? { top: at.top + at.line + 4 } : { bottom: `calc(100% - ${at.top}px + 4px)` }) }}
      className="absolute z-30 w-72 max-w-[90vw] border bg-popover py-1 text-sm shadow-md"
    >
      {shown.map((e, n) => (
        <button type="button" key={e.char + n} onMouseMove={() => setActive(n)} onClick={() => pick(e)} className={cn("flex w-full items-center gap-2 px-3 py-1 text-left", n === active && "bg-muted")}>
          <span className="w-5 text-center text-base">{e.char}</span>
          <span className="min-w-0 flex-1 truncate">:{e.names[0]}:</span>
        </button>
      ))}
    </div>
  );
  return { onKeyDown, panel, track };
}
