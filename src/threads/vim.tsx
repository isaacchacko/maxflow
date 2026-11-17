import { useEffect, useRef, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { restoring } from "./jump";

/** What the keys do to the item under the cursor; a page leaves out what it has no use for. */
export type VimActions = { open?(key: string): void; up?(): void; compose(): void; reply?(key: string): void; quote?(key: string): void; resolve?(key?: string): void; pause?(key?: string): void; section?(dir: 1 | -1, key?: string): string | undefined };

const HELP: [string, string][] = [
  ["j k", "next, previous"],
  ["gg G", "first, last"],
  ["Ctrl-d Ctrl-u", "half page down, up"],
  ["Enter l", "open"],
  ["h", "up a level"],
  ["i a", "write; Esc leaves an empty box"],
  ["r", "reply in thread"],
  ["y q", "quote"],
  ["x", "resolve, reopen"],
  ["p", "pause until a time"],
  ["/", "jump anywhere (⌘K)"],
  ["?", "these keys"],
];

// Where the cursor was in each thread (and the inbox), so coming back lands on it.
const STORE = "vim-cursor";
const saved: Record<string, string> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? "{}");
  } catch {
    return {};
  }
})();
function remember(scope: string, key: string) {
  saved[scope] = key;
  try {
    sessionStorage.setItem(STORE, JSON.stringify(saved));
  } catch {}
}

/** The keys are his only while nothing else takes them: a box he types in, an open dialog or menu, or a shortcut with ⌘ or ⌥. */
function elsewhere(e: KeyboardEvent) {
  const t = e.target instanceof Element ? e.target : null;
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.altKey || (e.ctrlKey && e.key !== "d" && e.key !== "u")) return true;
  if (t?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])") || document.querySelector('[role="dialog"], [role="menu"]')) return true;
  // Enter on a focused button or link is that control's.
  return e.key === "Enter" && !!t?.closest("a, button");
}

export const vimRow = (key: string) => ({ "data-vim": key });

/**
 * Vim motions over a list of items (a thread's messages, the inbox's rows), each drawn with `vimRow(key)` inside `scroller`.
 * The first motion lands on `start`: the last message in a thread, which opens at the bottom, or the inbox's top row.
 */
export function useVim(scope: string, items: string[], scroller: React.RefObject<HTMLElement | null>, start: "first" | "last", actions: VimActions) {
  const [cursor, setCursor] = useState<string | undefined>(() => saved[scope]);
  const [help, setHelp] = useState(false);
  const live = useRef({ items, actions, cursor, help });
  live.current = { items, actions, cursor, help };

  const row = (key: string) => scroller.current?.querySelector<HTMLElement>(`[data-vim="${CSS.escape(key)}"]`);
  const move = (key: string | undefined, scroll = true) => {
    if (!key) return;
    setCursor(key);
    remember(scope, key);
    if (scroll) requestAnimationFrame(() => row(key)?.scrollIntoView({ block: "nearest" }));
  };

  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      const { items, actions, cursor, help } = live.current;
      if (e.key === "Escape" && help) return void (e.preventDefault(), e.stopPropagation(), setHelp(false));
      if (elsewhere(e)) return;
      const at = cursor ? items.indexOf(cursor) : -1;
      const step = (by: number) => move(items[at < 0 ? (start === "first" ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, at + by))]);
      // Half a page: scroll half the pane and take the cursor the same distance, to the row nearest where it lands.
      const half = (dir: number) => {
        const el = scroller.current;
        if (!el) return;
        const by = (dir * el.clientHeight) / 2;
        const target = (row(cursor ?? "")?.getBoundingClientRect().top ?? el.getBoundingClientRect().top) + by;
        const nearest = items.reduce<{ key?: string; d: number }>((best, key) => {
          const top = row(key)?.getBoundingClientRect().top;
          const d = top === undefined ? Infinity : Math.abs(top - target);
          return d < best.d ? { key, d } : best;
        }, { d: Infinity });
        el.scrollBy({ top: by });
        move(nearest.key);
      };
      const keys: Record<string, () => void> = {
        j: () => step(1),
        k: () => step(-1),
        g: () => (Date.now() - g < 600 ? ((g = 0), move(items[0])) : (g = Date.now())),
        G: () => move(items.at(-1)),
        d: () => half(1),
        u: () => half(-1),
        Enter: () => cursor && actions.open?.(cursor),
        l: () => cursor && actions.open?.(cursor),
        h: () => actions.up?.(),
        i: () => actions.compose(),
        a: () => actions.compose(),
        r: () => cursor && actions.reply?.(cursor),
        y: () => cursor && actions.quote?.(cursor),
        q: () => cursor && actions.quote?.(cursor),
        x: () => actions.resolve?.(cursor),
        p: () => actions.pause?.(cursor),
        "]": () => move(actions.section?.(1, cursor)),
        "[": () => move(actions.section?.(-1, cursor)),
        "/": () => dispatchEvent(new Event("quick-switcher-open")),
        "?": () => setHelp(h => !h),
      };
      const run = (e.key === "d" || e.key === "u") && !e.ctrlKey ? undefined : keys[e.key];
      if (!run) return;
      // Taken, so i and a don't also type their letter into the box they focus.
      e.preventDefault();
      run();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [scope]);

  // Back in a thread, the cursor is where he left it; brought into view unless the page's scroll was put back as he left it.
  useEffect(() => {
    if (cursor && !restoring()) row(cursor)?.scrollIntoView({ block: "nearest" });
  }, [scope]);

  const panel = help && (
    <div data-agent="vim-help" className="fixed right-4 bottom-4 z-30 flex flex-col gap-1 rounded-2xl border bg-card p-3.5 text-xs shadow-raised">
      {HELP.map(([k, what]) => (
        <p key={k} className="flex items-center justify-between gap-6">
          <span className="flex gap-1">
            {k.split(" ").map(x => (
              <Kbd key={x}>{x}</Kbd>
            ))}
          </span>
          <span className="text-muted-foreground">{what}</span>
        </p>
      ))}
    </div>
  );
  return { cursor, move, panel };
}
