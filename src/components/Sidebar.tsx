import { CircleCheckBig, MessagesSquare, ShieldCheck, X, type LucideIcon } from "lucide-react";
import { AgentFace, type Expression } from "@/components/AgentFace";
import { Dots } from "@/components/Working";
import type { Thread } from "@/mock";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Mark } from "@/components/Mark";
import { cn } from "@/lib/utils";
import { setPinned, setPinOrder, taskStore, threadStore } from "@/store";
import { closePane, openPane } from "@/threads/pane";
import { unseenDeep, useSeen } from "@/threads/seen";

// The rail's 52px run from the window's edge to the panel's, so a glyph has as much room on its right as on its left.
// The app's frame, as Linear's is: the mark, then where he goes. It rests as a rail of glyphs; hovering it (or tabbing into it)
// opens it over the page without moving anything, and ⌘\ pins it open beside the page, at the width he dragged it to. Installed
// as an app with its window controls overlaid, its top strip, the row of the traffic lights, drags the window.

const KEY = "yarn-sidebar";
const RAIL = 52;
type Saved = { width: number; pinned: boolean };
const load = (): Saved => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { width: s.width ?? 216, pinned: !!s.pinned };
  } catch {
    return { width: 216, pinned: false };
  }
};

/** The ids with `dragged` moved to where `onto` is. */
const reorder = (ids: string[], dragged: string, onto: string) => {
  const rest = ids.filter(id => id !== dragged);
  rest.splice(rest.indexOf(onto) + (ids.indexOf(dragged) < ids.indexOf(onto) ? 1 : 0), 0, dragged);
  return rest;
};

// The yarn mark toggles Stats: clicked there, it goes back to wherever he opened Stats from, or the inbox when he landed on it.
let beforeStats = "#inbox";
const onStats = (hash: string) => hash === "#stats" || hash.startsWith("#stats/");
addEventListener("hashchange", e => {
  const old = new URL(e.oldURL).hash;
  if (onStats(location.hash) && old && !onStats(old)) beforeStats = old;
});
const toggleStats = (e: MouseEvent) => {
  if (!onStats(location.hash)) return;
  e.preventDefault();
  location.hash = beforeStats;
};

function Entry({ view, label, icon: Icon, count, warn, active, open }: { view: string; label: string; icon: LucideIcon; count: number; warn?: boolean; active: boolean; open: boolean }) {
  const badge = warn ? "bg-warn-soft text-warn" : "bg-new-soft text-new";
  return (
    <a
      href={`#${view}`}
      title={open ? undefined : label}
      data-agent={`sidebar:${view}`}
      className={cn("relative flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap", active ? "bg-black/[0.06] font-medium text-foreground" : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground")}
    >
      <Icon className="size-4 shrink-0" />
      {open ? (
        <>
          <span className="flex-1 truncate">{label}</span>
          {count > 0 && <span className={cn("rounded-full px-1.5 text-xs font-medium tabular-nums", badge)}>{count}</span>}
        </>
      ) : (
        // Folded to a rail, a count is only a dot on the glyph, taking no room; the number shows when it opens.
        count > 0 && <span aria-label={`${count}`} className={cn("absolute top-1.5 left-[1.55rem] size-2 rounded-full ring-2 ring-window", warn ? "bg-warn" : "bg-new")} />
      )}
    </a>
  );
}

/** A pinned thread's face, by what the thread is doing: a router at work, waiting on him, stopped short, paused, resolved. */
const pinExpression = (t: Thread): Expression =>
  t.resolved ? "done" : t.paused ? "asleep" : t.pending ? (t.pending.stale ? "error" : "working") : t.asks ? "waiting" : "idle";

/**
 * A pinned thread: its own face, its title, and whether it has news or a router at work on it. A click opens it as the page
 * (Isaac: "clicking a thread from sidebar should have it open as a full page") and ⇧-click beside it, the reverse of a thread in
 * the page; resolved or paused, it stays pinned, drawn muted.
 */
function PinnedEntry({ t, open, unread, onDrop }: { t: Thread; open: boolean; unread: number; onDrop(dragged: string): void }) {
  const working = !!t.pending && !t.pending.stale;
  const [over, setOver] = useState(false);
  return (
    <a
      href={`#thread/${t.id}`}
      title={`${t.title}\n⇧-click to open beside the page`}
      data-agent={`pinned:${t.id}`}
      draggable
      onDragStart={e => e.dataTransfer.setData("text/yarn-pin", t.id)}
      onDragOver={e => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={e => (e.preventDefault(), setOver(false), onDrop(e.dataTransfer.getData("text/yarn-pin")))}
      onClick={e => e.metaKey || e.ctrlKey || (e.preventDefault(), e.shiftKey ? openPane(t.id) : (closePane(), (location.hash = `thread/${t.id}`)))}
      className={cn("group/pin relative flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-sm whitespace-nowrap text-muted-foreground hover:bg-black/[0.04] hover:text-foreground", (t.resolved || t.paused) && "opacity-50", over && "ring-2 ring-link/40")}
    >
      {/* Its own face, from the thread's id so pins under one router still tell apart, doing what the thread is doing. */}
      <AgentFace id={t.id} expression={pinExpression(t)} small className="size-5 shrink-0" />
      {open ? (
        <>
          <span className="min-w-0 flex-1 truncate">{t.title}</span>
          {working && <Dots className="text-muted-foreground" />}
          {unread > 0 && <span className="rounded-full bg-new-soft px-1.5 text-xs font-medium text-new tabular-nums group-hover/pin:hidden">{unread}</span>}
          {/* Hovered, its × unpins it in place of the count, without opening it. */}
          <button
            aria-label="Unpin"
            title="Unpin"
            data-agent={`unpin:${t.id}`}
            onClick={e => (e.preventDefault(), e.stopPropagation(), void setPinned(t.id, false))}
            className="hidden shrink-0 rounded-md p-0.5 text-muted-foreground group-hover/pin:block hover:bg-black/[0.06] hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </>
      ) : (
        unread > 0 && <span className="absolute top-1 left-[1.45rem] size-2 rounded-full bg-new ring-2 ring-window" />
      )}
    </a>
  );
}

export function Sidebar({ view }: { view: string }) {
  const threads = threadStore.use();
  taskStore.use();
  useSeen();
  const [saved, setSaved] = useState(load);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const timer = useRef(0);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {}
  }, [saved]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && e.key === "\\" && (e.preventDefault(), setSaved(s => ({ ...s, pinned: !s.pinned })));
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  // Dragging its edge sets the open width, between a narrow column and a third of a laptop screen.
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = e.clientX - saved.width;
    const move = (m: PointerEvent) => setSaved(s => ({ ...s, width: Math.max(160, Math.min(360, m.clientX - start)) }));
    const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up));
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  const enter = () => (clearTimeout(timer.current), (timer.current = window.setTimeout(() => setHover(true), 150)));
  const leave = () => (clearTimeout(timer.current), setHover(false));
  const open = saved.pinned || hover || focused;
  const overlay = open && !saved.pinned;

  const tops = threads.filter(t => !t.parentId && !t.resolved && !t.paused);
  const needsYou = tops.filter(t => t.asks).length;
  const unread = tops.filter(t => unseenDeep(t, threads) > 0).length;
  const pins = threads.filter(t => t.pinned).sort((a, b) => a.pinned!.order - b.pinned!.order);
  return (
    // The rail holds its place in the layout; open over the page, the panel inside it is wider than the rail.
    <div style={{ width: saved.pinned ? saved.width : RAIL }} className="relative shrink-0 [app-region:no-drag]">
      <nav
        data-agent="sidebar"
        onMouseEnter={enter}
        onMouseLeave={leave}
        // Only keyboard focus opens it, not a click or focus a script moved here.
        onFocus={e => e.target.matches("a:focus-visible, button:focus-visible") && setFocused(true)}
        onBlur={e => e.currentTarget.contains(e.relatedTarget as Node) || setFocused(false)}
        style={{ width: open ? saved.width : RAIL }}
        className={cn("absolute inset-y-0 left-0 z-40 flex flex-col overflow-hidden bg-window px-2 pb-2 transition-[width] duration-150 ease-out", overlay && "rounded-r-xl border-r shadow-raised")}
      >
        {/* The row the traffic lights sit in: nothing of ours, and it drags the window. */}
        <div style={{ height: "env(titlebar-area-height, 0.5rem)" }} className="shrink-0 [app-region:drag]" />
        <div className="mb-1 flex h-10 shrink-0 items-center gap-1.5 px-1.5">
          <a href="#stats" onClick={toggleStats} data-agent="sidebar:stats" title="Stats" className="rounded-md [app-region:no-drag]">
            <Mark compact={!open} />
          </a>
        </div>
        <div className="flex flex-col gap-0.5">
          <Entry view="todo" label="Todo" icon={CircleCheckBig} count={needsYou} warn active={view === "todo"} open={open} />
          <Entry view="inbox" label="Threads" icon={MessagesSquare} count={unread} active={view === "inbox"} open={open} />
          <Entry view="restrictions" label="Restrictions" icon={ShieldCheck} count={0} active={view === "restrictions"} open={open} />
        </div>
        {pins.length > 0 && (
          <div data-agent="sidebar-pinned" className="mt-3 flex min-h-0 flex-col gap-0.5 overflow-y-auto [scrollbar-width:none]">
            {open ? <p className="shrink-0 px-2.5 pb-1 text-xs font-medium text-muted-foreground">Pinned</p> : <span className="mx-2.5 mb-1.5 h-px shrink-0 bg-border" />}
            {pins.map(t => (
              <PinnedEntry key={t.id} t={t} open={open} unread={unseenDeep(t, threads)} onDrop={dragged => dragged && dragged !== t.id && void setPinOrder(reorder(pins.map(x => x.id), dragged, t.id))} />
            ))}
          </div>
        )}
        {open && <div onPointerDown={drag} title={saved.pinned ? "Drag to resize · ⌘\\ to unpin" : "Drag to resize · ⌘\\ to pin open"} className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize" />}
      </nav>
    </div>
  );
}
