import { useMemo, useState } from "react";
import { useKeyedState } from "@/lib/useKeyedState";
import { score, useThreadItems, type Item } from "@/components/QuickSwitcher";
import { cn, hasText } from "@/lib/utils";
import type { Agent } from "@/mock";
import { agentStore, objectiveStore, sentryStore } from "@/store";
import { isAcceptKey, isNextKey, isPreviousKey } from "./picker-keys";
import { Avatar } from "./Rich";

const SHOWN = 8;
const AGENTS_SHOWN = 4;
const PANEL_WIDTH_PX = 320;
const ROOM_ABOVE_PX = 320;
const AT_AND_UP_TO_FOUR_WORDS_BEFORE_CARET = /(?:^|\s)@([^\s@\]]{0,40}(?: [^\s@\]]{1,40}){0,3})$/;

export function caretAt(el: HTMLTextAreaElement, pos: number) {
  const style = getComputedStyle(el);
  const copy = document.createElement("div");
  for (const p of ["font", "letterSpacing", "lineHeight", "padding", "border", "boxSizing", "whiteSpace", "wordWrap", "tabSize"] as const) copy.style[p] = style[p];
  Object.assign(copy.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", width: `${el.clientWidth}px` });
  copy.textContent = el.value.slice(0, pos);
  const mark = document.createElement("span");
  copy.append(mark);
  mark.textContent = "\u{200B}";
  document.body.append(copy);
  const at = { left: mark.offsetLeft, top: mark.offsetTop - el.scrollTop, line: mark.offsetHeight };
  copy.remove();
  return at;
}

type Caret = ReturnType<typeof caretAt>;

function useAgentItems() {
  const agents = agentStore.use();
  const sentries = sentryStore.use();
  const objectives = objectiveStore.use();
  return useMemo<Item[]>(() => {
    type Named = Agent & { name: string };
    const title = (id: string) => objectives.find(o => o.id === id)?.title;
    const agentSentries = sentries.filter(s => s.running && s.agent === true);
    const isMentionable = (a: Agent): a is Named => hasText(a.name) && !(a.objectiveId === "unrouted" && a.name === "funnel") && agentSentries.every(s => s.id !== a.id);
    return [
      ...agents.filter(isMentionable).map(a => ({ id: a.id, name: a.name, detail: [a.role, title(a.objectiveId)].filter(Boolean).join(" · ") })),
      ...agentSentries.map(s => ({ id: s.id, name: s.name, detail: "sentry" })),
    ].map(a => ({ kind: "Agents" as const, href: `#agent/${a.id}`, label: a.name, detail: a.detail, icon: <Avatar from={a.id} small />, text: `${a.name} ${a.id}`, rank: 0 }));
  }, [agents, sentries, objectives]);
}

type Scored = Item & { s: number };
function byScoreThenRank(a: Scored, b: Scored) {
  const byScore = b.s - a.s;
  return byScore === 0 ? b.rank - a.rank : byScore;
}

function matching(q: string, list: Item[]): Scored[] {
  return list
    .map(i => ({ i, name: score(q, i.label, true), body: score(q, i.text, false) }))
    .filter(({ name, body }) => name !== null || body !== null)
    .map(({ i, name, body }) => ({ ...i, s: Math.max(name ?? 0, (body ?? 0) - 100) }))
    .toSorted(byScoreThenRank);
}

function mentionsFor(query: string, threadItems: Item[], agents: Item[], here: string | undefined) {
  const threads = threadItems.filter(i => i.href !== `#thread/${here}`);
  const q = query.trim();
  const who = (q ? matching(q, agents) : agents).slice(0, AGENTS_SHOWN);
  return [...who, ...(q ? matching(q, threads) : threads.toSorted((a, b) => b.rank - a.rank)).slice(0, SHOWN - who.length)];
}

function MentionPanel({ at, el, query, shown, active, setActive, pick }: { at: Caret; el: HTMLTextAreaElement; query: string; shown: Item[]; active: number; setActive: (n: number) => void; pick: (item: Item) => void }) {
  const isBelow = el.getBoundingClientRect().top + at.top < ROOM_ABOVE_PX;
  return (
    <div
      data-agent="mention-picker"
      onMouseDown={e => e.preventDefault()}
      style={{ left: Math.min(at.left, el.clientWidth - PANEL_WIDTH_PX), ...(isBelow ? { top: at.top + at.line + 4 } : { bottom: `calc(100% - ${at.top}px + 4px)` }) }}
      className="absolute z-30 w-80 max-w-[90vw] border bg-popover py-1 text-sm shadow-md"
    >
      {shown.length === 0 && <p className="px-3 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">Nothing matches “{query}”</p>}
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
          {item.kind === "Agents" && hasText(item.detail) && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{item.detail}</span>}
          {hasText(item.detail) && /^\d+ new$/.test(item.detail) && <span className="shrink-0 text-xs text-new">{item.detail}</span>}
        </button>,
      ])}
    </div>
  );
}

export function useMentionPicker(input: React.RefObject<HTMLTextAreaElement | null>, draft: string, setDraft: (text: string) => void, here?: string) {
  const items = useThreadItems();
  const agents = useAgentItems();
  const [caret, setCaret] = useState(0);

  const typed = AT_AND_UP_TO_FOUR_WORDS_BEFORE_CARET.exec(draft.slice(0, caret));
  const query = typed?.[1] ?? "";
  const start = typed ? caret - query.length - 1 : -1;
  const [active, setActive] = useKeyedState(`${start}:${query}`, 0);
  const [dismissedAt, setDismissedAt] = useKeyedState(start >= 0, -1);

  const shown = useMemo(() => (start < 0 ? [] : mentionsFor(query, items, agents, here)), [items, agents, query, start, here]);
  const isJustText = shown.length === 0 && query.includes(" ");
  const isOpen = start >= 0 && start !== dismissedAt && !isJustText;

  function pick(item: Item | undefined) {
    const el = input.current;
    if (!item || !el) return;
    const ref = `[[${item.href.replace(/^#(\w+)\//, "$1:")}]] `;
    setDraft(`${draft.slice(0, start)}${ref}${draft.slice(caret)}`);
    const at = start + ref.length;
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
    else if (isAcceptKey(e) && shown.length > 0) pick(shown[active]);
    else if (e.key === "Escape") setDismissedAt(start);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  const track = () => setCaret(input.current?.selectionStart ?? 0);
  const el = input.current;
  const at = isOpen && el ? caretAt(el, start) : undefined;
  const panel = at && el && <MentionPanel at={at} el={el} query={query} shown={shown} active={active} setActive={setActive} pick={pick} />;
  return { onKeyDown: didHandleKey, track, panel };
}
