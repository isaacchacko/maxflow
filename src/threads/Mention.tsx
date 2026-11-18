import { useEffect, useMemo, useState } from "react";
import { score, useThreadItems, type Item } from "@/components/QuickSwitcher";
import { cn } from "@/lib/utils";

const SHOWN = 8;
// An @ at the start or after a space, then up to four words typed since, all before the caret.
const AT = /(?:^|\s)@([^\s@\]]{0,40}(?: [^\s@\]]{1,40}){0,3})$/;

/** Where the caret sits inside a textarea, in px from its top-left: a hidden copy of the box with the same text wrapping finds it. */
export function caretAt(el: HTMLTextAreaElement, pos: number) {
  const style = getComputedStyle(el);
  const copy = document.createElement("div");
  for (const p of ["font", "letterSpacing", "lineHeight", "padding", "border", "boxSizing", "whiteSpace", "wordWrap", "tabSize"] as const) copy.style[p] = style[p];
  Object.assign(copy.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", width: `${el.clientWidth}px` });
  copy.textContent = el.value.slice(0, pos);
  const mark = copy.appendChild(document.createElement("span"));
  mark.textContent = "​";
  document.body.appendChild(copy);
  const at = { left: mark.offsetLeft, top: mark.offsetTop - el.scrollTop, line: mark.offsetHeight };
  copy.remove();
  return at;
}

/**
 * Typing @ in a composer lists the threads to mention: unread and recently moved first, then by how well the title or opening
 * message matches what follows the @, as the quick switcher ranks them. ↑↓ (or Ctrl-n/p) move, Enter or Tab inserts
 * [[thread:<id>]], Esc dismisses that @. `here` leaves out the thread being written in.
 */
export function useMentionPicker(input: React.RefObject<HTMLTextAreaElement | null>, draft: string, setDraft: (text: string) => void, here?: string) {
  const items = useThreadItems();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(-1);

  const typed = draft.slice(0, caret).match(AT);
  const query = typed?.[1] ?? "";
  const start = typed ? caret - query.length - 1 : -1;

  const shown = useMemo(() => {
    if (start < 0) return [];
    const threads = items.filter(i => i.href !== `#thread/${here}`);
    const q = query.trim();
    if (!q) return [...threads].sort((a, b) => b.rank - a.rank).slice(0, SHOWN);
    return threads
      .flatMap(i => {
        const name = score(q, i.label, true), body = score(q, i.text, false);
        return name === null && body === null ? [] : [{ ...i, s: Math.max(name ?? 0, (body ?? 0) - 100) }];
      })
      .sort((a, b) => b.s - a.s || b.rank - a.rank)
      .slice(0, SHOWN);
  }, [items, query, start, here]);

  // Past a space with nothing matching, the @ was just text.
  const open = start >= 0 && start !== dismissed && (shown.length > 0 || !query.includes(" "));
  useEffect(() => setActive(0), [query, start]);
  // Esc dismisses one @; once it's deleted, a new @ in the same place opens again.
  useEffect(() => {
    if (start < 0) setDismissed(-1);
  }, [start]);

  function pick(item: Item | undefined) {
    const el = input.current;
    if (!item || !el) return;
    const ref = `[[thread:${item.href.replace("#thread/", "")}]] `;
    setDraft(draft.slice(0, start) + ref + draft.slice(caret));
    const at = start + ref.length;
    requestAnimationFrame(() => (el.focus(), el.setSelectionRange(at, at), setCaret(at)));
  }

  /** The composer's keys go here first; true when the picker took the key. */
  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return false;
    const down = e.key === "ArrowDown" || (e.ctrlKey && e.key === "n"), up = e.key === "ArrowUp" || (e.ctrlKey && e.key === "p");
    if (down) setActive(a => Math.min(shown.length - 1, a + 1));
    else if (up) setActive(a => Math.max(0, a - 1));
    else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing && shown.length) pick(shown[active]);
    else if (e.key === "Escape") setDismissed(start);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  const track = () => setCaret(input.current?.selectionStart ?? 0);
  const el = input.current;
  const at = open && el ? caretAt(el, start) : undefined;
  // Above the caret, unless that would run off the top of the window.
  const below = !!(at && el && el.getBoundingClientRect().top + at.top < 320);
  const panel = at && (
    <div
      data-agent="mention-picker"
      onMouseDown={e => e.preventDefault()}
      style={{ left: Math.min(at.left, (el?.clientWidth ?? 0) - 320), ...(below ? { top: at.top + at.line + 4 } : { bottom: `calc(100% - ${at.top}px + 4px)` }) }}
      className="absolute z-30 w-80 max-w-[90vw] border bg-popover py-1 text-sm shadow-md"
    >
      <p className="px-3 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">{shown.length ? "Mention a thread" : `No thread matches “${query}”`}</p>
      {shown.map((item, n) => (
        <button
          type="button"
          key={item.href}
          onMouseMove={() => setActive(n)}
          onClick={() => pick(item)}
          className={cn("flex w-full items-center gap-2 px-3 py-1 text-left", n === active && "bg-muted")}
        >
          <span className="flex w-5 shrink-0 justify-center">{item.icon}</span>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.detail && /^\d+ new$/.test(item.detail) && <span className="shrink-0 text-xs text-new">{item.detail}</span>}
        </button>
      ))}
    </div>
  );
  return { onKeyDown, track, panel };
}
