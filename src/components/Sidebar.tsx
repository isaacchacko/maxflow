import { CircleCheckBig, MessagesSquare, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Mark } from "@/components/Mark";
import { cn } from "@/lib/utils";
import { taskStore, threadStore } from "@/store";
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
          <Mark compact={!open} />
        </div>
        <div className="flex flex-col gap-0.5">
          <Entry view="todo" label="Todo" icon={CircleCheckBig} count={needsYou} warn active={view === "todo"} open={open} />
          <Entry view="inbox" label="Threads" icon={MessagesSquare} count={unread} active={view === "inbox"} open={open} />
        </div>
        {open && <div onPointerDown={drag} title={saved.pinned ? "Drag to resize · ⌘\\ to unpin" : "Drag to resize · ⌘\\ to pin open"} className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize" />}
      </nav>
    </div>
  );
}
