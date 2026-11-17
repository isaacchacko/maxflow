import { CircleCheckBig, MessagesSquare, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Capture } from "@/components/Capture";
import { Mark } from "@/components/Mark";
import { cn } from "@/lib/utils";
import { taskStore, threadStore } from "@/store";
import { unseenDeep, useSeen } from "@/threads/seen";

// The app's frame, as Linear's is: the mark, then where he goes. Collapses with ⌘\ and keeps its width. Installed as an app with
// its window controls overlaid, its top strip is what drags the window, clear of the traffic lights.

const KEY = "yarn-sidebar";
type Saved = { width: number; collapsed: boolean };
const load = (): Saved => {
  try {
    return { width: 216, collapsed: false, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { width: 216, collapsed: false };
  }
};

function Entry({ view, label, icon: Icon, count, warn, active }: { view: string; label: string; icon: LucideIcon; count: number; warn?: boolean; active: boolean }) {
  return (
    <a
      href={`#${view}`}
      data-agent={`sidebar:${view}`}
      className={cn("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm", active ? "bg-black/[0.06] font-medium text-foreground" : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground")}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && <span className={cn("rounded-full px-1.5 text-xs font-medium tabular-nums", warn ? "bg-warn-soft text-warn" : "bg-new-soft text-new")}>{count}</span>}
    </a>
  );
}

export function Sidebar({ view }: { view: string }) {
  const threads = threadStore.use();
  taskStore.use();
  useSeen();
  const [saved, setSaved] = useState(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {}
  }, [saved]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && e.key === "\\" && (e.preventDefault(), setSaved(s => ({ ...s, collapsed: !s.collapsed })));
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  // Dragging its edge sets the width, between a narrow rail and a third of a laptop screen.
  const drag = (e: React.PointerEvent) => {
    const start = e.clientX - saved.width;
    const move = (m: PointerEvent) => setSaved(s => ({ ...s, width: Math.max(160, Math.min(360, m.clientX - start)) }));
    const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up));
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  if (saved.collapsed) return null;
  const tops = threads.filter(t => !t.parentId && !t.resolved && !t.paused);
  const needsYou = tops.filter(t => t.asks).length;
  const unread = tops.filter(t => unseenDeep(t, threads) > 0).length;
  return (
    <nav data-agent="sidebar" style={{ width: saved.width }} className="relative flex shrink-0 flex-col gap-0.5 pr-2 pl-2 [app-region:no-drag]">
      <div
        style={{ paddingLeft: "max(0.375rem, calc(env(titlebar-area-x, 0px) - 0.5rem))", minHeight: "max(2.5rem, env(titlebar-area-height, 0px))" }}
        className="mb-1 flex items-center justify-between gap-2 [app-region:drag]"
      >
        <Mark className="[app-region:no-drag]" />
        <span className="[app-region:no-drag]">
          <Capture />
        </span>
      </div>
      <Entry view="todo" label="Todo" icon={CircleCheckBig} count={needsYou} warn active={view === "todo"} />
      <Entry view="inbox" label="Threads" icon={MessagesSquare} count={unread} active={view === "inbox"} />
      <div onPointerDown={drag} title="Drag to resize · ⌘\ to hide" className="absolute inset-y-0 -right-1 w-2 cursor-col-resize" />
    </nav>
  );
}
