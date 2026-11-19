import { useMemo, useRef, useState } from "react";
import { useResource } from "@/lib/effects";
import { useKeyedState } from "@/lib/useKeyedState";
import { emojiReady, emojiTable, loadEmoji, recentEmoji, searchEmoji, searchEmojiIn, usedEmoji, type Emoji } from "@/lib/emoji";
import { cn } from "@/lib/utils";
import { caretAt } from "./Mention";
import { isAcceptKey, isNextKey, isPreviousKey } from "./picker-keys";

const CATEGORY_MARKS_IN_DATA_ORDER = ["😀", "👋", "🐈", "🍎", "✈️", "⚽", "💡", "❤️", "🏁"];

export function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }) {
  emojiReady.use();
  useResource("emoji", loadEmoji);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<Emoji>();
  const grid = useRef<HTMLDivElement>(null);
  const table = emojiTable();
  const recent = useMemo(() => recentEmoji().flatMap(c => table?.list.find(e => e.char === c) ?? []), [table]);
  const found = query.trim() ? searchEmoji(query.trim(), 300) : undefined;
  const pick = (e: Emoji) => {
    usedEmoji(e.char);
    onPick(e.char);
  };
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
  const results = (list: Emoji[]) => (list.length > 0 ? section("Results", list) : <p className="p-3 text-xs text-muted-foreground">No emoji for “{query}”</p>);
  return (
    <div data-agent="emoji-panel" className="flex w-80 flex-col">
      <input
        autoFocus
        data-agent="emoji-search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          const first = found?.[0];
          if (!first || e.key !== "Enter") return;
          e.preventDefault();
          pick(first);
        }}
        placeholder="Search all emoji"
        className="m-2 mb-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring"
      />
      {!found && table && (
        <nav className="flex justify-between px-2 pb-1">
          {table.categories.map((c, i) => (
            <button key={c} type="button" title={c} onMouseDown={ev => ev.preventDefault()} onClick={() => grid.current?.querySelector(`[data-section="${CSS.escape(String(i))}"]`)?.scrollIntoView()} className="flex size-7 items-center justify-center rounded-md text-base opacity-70 hover:bg-muted hover:opacity-100">
              {CATEGORY_MARKS_IN_DATA_ORDER[i]}
            </button>
          ))}
        </nav>
      )}
      <div ref={grid} className="h-64 overflow-y-auto px-1.5">
        {!table && <p className="p-3 text-xs text-muted-foreground">Loading emoji…</p>}
        {found ? results(found) : table && [section("Recent", recent), ...table.categories.map((c, i) => section(c, table.list.filter(e => e.category === i), String(i)))]}
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

const COLON_AND_SHORTCODE_AT_CARET = /(?:^|\s):([a-z0-9_+'-]{2,40})$/i;
const PANEL_WIDTH_PX = 288;
const ROOM_ABOVE_PX = 320;

type Caret = NonNullable<ReturnType<typeof caretAt>>;

function CompletePanel({ at, el, shown, active, setActive, pick }: { at: Caret; el: HTMLTextAreaElement; shown: Emoji[]; active: number; setActive: (n: number) => void; pick: (e: Emoji) => void }) {
  const isBelow = el.getBoundingClientRect().top + at.top < ROOM_ABOVE_PX;
  return (
    <div
      data-agent="emoji-complete"
      onMouseDown={e => e.preventDefault()}
      style={{ left: Math.min(at.left, el.clientWidth - PANEL_WIDTH_PX), ...(isBelow ? { top: at.top + at.line + 4 } : { bottom: `calc(100% - ${at.top}px + 4px)` }) }}
      className="absolute z-30 w-72 max-w-[90vw] border bg-popover py-1 text-sm shadow-md"
    >
      {shown.map((e, n) => (
        <button type="button" key={`${e.char}${n}`} onMouseMove={() => setActive(n)} onClick={() => pick(e)} className={cn("flex w-full items-center gap-2 px-3 py-1 text-left", n === active && "bg-muted")}>
          <span className="w-5 text-center text-base">{e.char}</span>
          <span className="min-w-0 flex-1 truncate">:{e.names[0]}:</span>
        </button>
      ))}
    </div>
  );
}

export function useEmojiComplete(input: React.RefObject<HTMLTextAreaElement | null>, draft: string, setDraft: (text: string) => void) {
  emojiReady.use();
  const table = emojiTable();
  const [caret, setCaret] = useState(0);
  const typed = COLON_AND_SHORTCODE_AT_CARET.exec(draft.slice(0, caret));
  const query = typed?.[1] ?? "";
  const start = typed ? caret - query.length - 1 : -1;
  useResource(start >= 0 ? "emoji" : undefined, loadEmoji);
  const [active, setActive] = useKeyedState(`${start}:${query}`, 0);
  const [dismissed, setDismissed] = useKeyedState(start >= 0, -1);
  const shown = useMemo(() => (start >= 0 ? searchEmojiIn(table, query, 8) : []), [query, start, table]);
  const isOpen = start >= 0 && start !== dismissed && shown.length > 0;

  function pick(e: Emoji | undefined) {
    const el = input.current;
    if (!e || !el) return;
    usedEmoji(e.char);
    setDraft(`${draft.slice(0, start)}${e.char} ${draft.slice(caret)}`);
    const at = start + e.char.length + 1;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
      setCaret(at);
    });
  }
  function didHandleKey(e: React.KeyboardEvent) {
    if (!isOpen) return false;
    if (isNextKey(e)) setActive(a => Math.min(shown.length - 1, a + 1));
    else if (isPreviousKey(e)) setActive(a => Math.max(0, a - 1));
    else if (isAcceptKey(e)) pick(shown[active]);
    else if (e.key === "Escape") setDismissed(start);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  const track = () => setCaret(input.current?.selectionStart ?? 0);
  const el = input.current;
  const at = isOpen && el ? caretAt(el, start) : undefined;
  const panel = at && el && <CompletePanel at={at} el={el} shown={shown} active={active} setActive={setActive} pick={pick} />;
  return { onKeyDown: didHandleKey, panel, track };
}
