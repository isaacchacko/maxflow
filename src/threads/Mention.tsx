import { useEffect, useMemo, useState } from "react";
import { score, useThreadItems, type Item } from "@/components/QuickSwitcher";
import { cn } from "@/lib/utils";
import { agentStore, objectiveStore, sentryStore } from "@/store";
import { Avatar } from "./Rich";

const SHOWN = 8;
const AGENTS_SHOWN = 4;
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

/** The live agents and agent sentries he can @, each as [[agent:<id>]]: routers, workers, and sentries by their short name (@funnel). */
function useAgentItems() {
  const agents = agentStore.use();
  const sentries = sentryStore.use();
  const objectives = objectiveStore.use();
  return useMemo<Item[]>(() => {
    const title = (id: string) => objectives.find(o => o.id === id)?.title;
    const sentry = sentries.filter(s => s.running && s.agent);
    // The world draws unrouted agents under a stand-in funnel; the real one, when it runs, is among the sentries.
    const agent = agents.filter(a => a.name && !(a.objectiveId === "unrouted" && a.name === "funnel") && !sentry.some(s => s.id === a.id));
    return [
      ...agent.map(a => ({ id: a.id, name: a.name!, detail: [a.role, title(a.objectiveId)].filter(Boolean).join(" · ") })),
      ...sentry.map(s => ({ id: s.id, name: s.name, detail: "sentry" })),
    ].map(a => ({ kind: "Agents" as const, href: `#agent/${a.id}`, label: a.name, detail: a.detail, icon: <Avatar from={a.id} small />, text: `${a.name} ${a.id}`, rank: 0 }));
  }, [agents, sentries, objectives]);
}

/**
 * Typing @ in a composer lists the agents and threads to mention. Agents and sentries come first, by how well their name matches
 * what follows the @; threads after, unread and recently moved first, then by how well the title or opening message matches, as
 * the quick switcher ranks them. ↑↓ (or Ctrl-n/p) move, Enter or Tab inserts [[agent:<id>]] or [[thread:<id>]], Esc dismisses
 * that @. `here` leaves out the thread being written in.
 */
export function useMentionPicker(input: React.RefObject<HTMLTextAreaElement | null>, draft: string, setDraft: (text: string) => void, here?: string) {
  const items = useThreadItems();
  const agents = useAgentItems();
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
    const matching = (list: Item[]) =>
      list
        .flatMap(i => {
          const name = score(q, i.label, true), body = score(q, i.text, false);
          return name === null && body === null ? [] : [{ ...i, s: Math.max(name ?? 0, (body ?? 0) - 100) }];
        })
        .sort((a, b) => b.s - a.s || b.rank - a.rank);
    const who = (q ? matching(agents) : agents).slice(0, AGENTS_SHOWN);
    return [...who, ...(q ? matching(threads) : [...threads].sort((a, b) => b.rank - a.rank)).slice(0, SHOWN - who.length)];
  }, [items, agents, query, start, here]);

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
    const ref = `[[${item.href.replace(/^#(\w+)\//, "$1:")}]] `;
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
      {!shown.length && <p className="px-3 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">Nothing matches “{query}”</p>}
      {shown.map((item, n) => [
        item.kind !== shown[n - 1]?.kind && (
          <p key={item.kind} className="px-3 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">
            {item.kind === "Agents" ? "Mention an agent" : "Mention a thread"}
          </p>
        ),
        <button
          type="button"
          key={item.href}
          onMouseMove={() => setActive(n)}
          onClick={() => pick(item)}
          className={cn("flex w-full items-center gap-2 px-3 py-1 text-left", n === active && "bg-muted")}
        >
          <span className="flex w-5 shrink-0 justify-center">{item.icon}</span>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.kind === "Agents" && item.detail && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{item.detail}</span>}
          {item.detail && /^\d+ new$/.test(item.detail) && <span className="shrink-0 text-xs text-new">{item.detail}</span>}
        </button>,
      ])}
    </div>
  );
  return { onKeyDown, track, panel };
}
