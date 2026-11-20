import { CircleCheckBig, FileText, GitPullRequest, Globe, History, MessagesSquare, ShieldCheck, X, type LucideIcon } from "lucide-react";
import { AgentFace, type Expression } from "@/components/AgentFace";
import { Dots } from "@/components/Working";
import type { Thread } from "@/mock";
import { useRef, useState, type MouseEvent } from "react";
import { useEventListener } from "@/lib/effects";
import { Mark } from "@/components/Mark";
import { ResourceReadout } from "@/components/ResourceReadout";
import { CursorToggle } from "@/cursors/CursorToggle";
import { cn, hasText } from "@/lib/utils";
import { agentStore, setPinned, setPinOrder, taskStore, threadStore } from "@/store";
import { closePane, openPane } from "@/threads/pane";
import { unseenDeep, useSeen } from "@/threads/seen";
import { isRecord } from "../../shared/guards";
import { shouldKeepLooking, PRS_URL, type PrRow } from "@/views/PrsView";
import { useJson } from "@/views/stats/load";

const KEY = "yarn-sidebar";
const useReadyToMerge = () => useJson<PrRow[]>(PRS_URL, shouldKeepLooking).value?.filter(r => r.ready).length ?? 0;
const RAIL = 52;
const DEFAULT_WIDTH = 216;
type Saved = { width: number; pinned: boolean };
const load = (): Saved => {
  try {
    const s: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!isRecord(s)) return { width: DEFAULT_WIDTH, pinned: false };
    return { width: typeof s["width"] === "number" ? s["width"] : DEFAULT_WIDTH, pinned: s["pinned"] === true };
  } catch {
    return { width: DEFAULT_WIDTH, pinned: false };
  }
};
const keep = (s: Saved) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // constraint: localStorage throws in a private window or on a full quota; the width and pin then last only this page load
  }
  return s;
};

const reorder = (ids: string[], dragged: string, onto: string) => {
  const rest = ids.filter(id => id !== dragged);
  rest.splice(rest.indexOf(onto) + (ids.indexOf(dragged) < ids.indexOf(onto) ? 1 : 0), 0, dragged);
  return rest;
};

const markGoesBackTo = { hash: "#inbox" };
const isOnStats = (hash: string) => hash === "#stats" || hash.startsWith("#stats/");
addEventListener("hashchange", (e: HashChangeEvent) => {
  const old = new URL(e.oldURL).hash;
  if (old && isOnStats(location.hash) && !isOnStats(old)) markGoesBackTo.hash = old;
});
const toggleStats = (e: MouseEvent) => {
  if (!isOnStats(location.hash)) return;
  e.preventDefault();
  location.hash = markGoesBackTo.hash;
};

function Entry({ view, label, icon: Icon, count, warn, active, open }: { view: string; label: string; icon: LucideIcon; count: number; warn?: boolean; active: boolean; open: boolean }) {
  const badge = warn === true ? "bg-warn-soft text-warn" : "bg-new-soft text-new";
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
        count > 0 && <span aria-label={String(count)} className={cn("absolute top-1.5 left-[1.55rem] size-2 rounded-full ring-2 ring-window", warn === true ? "bg-warn" : "bg-new")} />
      )}
    </a>
  );
}

function pinExpression(t: Thread): Expression {
  if (t.resolved) return "done";
  if (t.paused) return "asleep";
  if (t.pending?.waitingOn !== undefined) return "waiting";
  if (t.pending) return t.pending.stale ? "error" : "working";
  return t.asks ? "waiting" : "idle";
}

function openPinned(e: React.MouseEvent, threadId: string) {
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  if (e.shiftKey) {
    openPane(threadId);
    return;
  }
  closePane();
  location.hash = `thread/${threadId}`;
}

function PinnedEntry({ t, open, unread, onDrop }: { t: Thread; open: boolean; unread: number; onDrop: (dragged: string) => void }) {
  const isWorking = Boolean(t.pending) && t.pending?.stale !== true && t.pending?.waitingOn === undefined;
  const [over, setOver] = useState(false);
  return (
    <a
      href={`#thread/${t.id}`}
      title={`${t.title}\n⇧-click to open beside the page`}
      data-agent={`pinned:${t.id}`}
      draggable
      onDragStart={e => e.dataTransfer.setData("text/yarn-pin", t.id)}
      onDragOver={e => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        onDrop(e.dataTransfer.getData("text/yarn-pin"));
      }}
      onClick={e => openPinned(e, t.id)}
      className={cn("group/pin relative flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-sm whitespace-nowrap text-muted-foreground hover:bg-black/[0.04] hover:text-foreground", Boolean(t.resolved ?? t.paused) && "opacity-50", over && "ring-2 ring-link/40")}
    >
      <AgentFace id={t.id} expression={pinExpression(t)} small className="size-5 shrink-0" />
      {open ? (
        <>
          <span className="min-w-0 flex-1 truncate">{t.title}</span>
          {isWorking && <Dots className="text-muted-foreground" />}
          {unread > 0 && <span className="rounded-full bg-new-soft px-1.5 text-xs font-medium text-new tabular-nums group-hover/pin:hidden">{unread}</span>}
          <button
            aria-label="Unpin"
            title="Unpin"
            data-agent={`unpin:${t.id}`}
            onClick={e => {
              e.preventDefault();
              e.stopPropagation();
              void setPinned(t.id, false);
            }}
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

function dragToResize(e: React.PointerEvent, width: number, setSaved: (change: (s: Saved) => Saved) => void) {
  e.preventDefault();
  const start = e.clientX - width;
  const move = (m: PointerEvent) => setSaved(s => ({ ...s, width: Math.max(160, Math.min(360, m.clientX - start)) }));
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

function useHoverOpen() {
  const [isHovered, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const enter = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(true), 150);
  };
  const leave = () => {
    clearTimeout(timer.current);
    setHover(false);
  };
  return { isHovered, enter, leave };
}

export function Sidebar({ view }: { view: string }) {
  const threads = threadStore.use();
  const browsing = agentStore.use().filter(a => a.browser === true).length;
  taskStore.use();
  useSeen();
  const [saved, setSavedState] = useState(load);
  const setSaved = (change: (s: Saved) => Saved) => setSavedState(s => keep(change(s)));
  const { isHovered, enter, leave } = useHoverOpen();
  const [focused, setFocused] = useState(false);
  useEventListener("keydown", e => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== "\\") return;
    e.preventDefault();
    setSaved(s => ({ ...s, pinned: !s.pinned }));
  });
  const isOpen = saved.pinned || isHovered || focused;
  const isOverlay = isOpen && !saved.pinned;

  const tops = threads.filter(t => !hasText(t.parentId) && !t.resolved && !t.paused);
  const needsYou = tops.filter(t => t.asks).length;
  const readyToMerge = useReadyToMerge();
  const unread = tops.filter(t => unseenDeep(t, threads) > 0).length;
  const pins = threads.filter(t => t.pinned).toSorted((a, b) => (a.pinned?.order ?? 0) - (b.pinned?.order ?? 0));
  const dropPin = (onto: string) => (dragged: string) => {
    if (dragged && dragged !== onto) void setPinOrder(reorder(pins.map(x => x.id), dragged, onto));
  };
  return (
    <div style={{ width: saved.pinned ? saved.width : RAIL }} className="relative shrink-0 [app-region:no-drag]">
      <nav
        data-agent="sidebar"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={e => e.target.matches("a:focus-visible, button:focus-visible") && setFocused(true)}
        onBlur={e => e.currentTarget.contains(e.relatedTarget) || setFocused(false)}
        style={{ width: isOpen ? saved.width : RAIL }}
        className={cn("absolute inset-y-0 left-0 z-40 flex flex-col overflow-hidden bg-window px-2 pb-2 transition-[width] duration-150 ease-out", isOverlay && "rounded-r-xl border-r shadow-raised")}
      >
        <div style={{ height: "env(titlebar-area-height, 0.5rem)" }} className="shrink-0 [app-region:drag]" />
        <div className="mb-1 flex h-10 shrink-0 items-center gap-1.5 px-1.5">
          <a href="#stats" onClick={toggleStats} data-agent="sidebar:stats" title="Stats" className="rounded-md [app-region:no-drag]">
            <Mark compact={!isOpen} />
          </a>
        </div>
        <div className="flex flex-col gap-0.5">
          <Entry view="todo" label="Todo" icon={CircleCheckBig} count={needsYou} warn active={view === "todo"} open={isOpen} />
          <Entry view="inbox" label="Threads" icon={MessagesSquare} count={unread} active={view === "inbox"} open={isOpen} />
          <Entry view="prs" label="PRs" icon={GitPullRequest} count={readyToMerge} warn active={view === "prs"} open={isOpen} />
          <Entry view="timelines" label="Timelines" icon={History} count={0} active={view === "timelines"} open={isOpen} />
          <Entry view="docs" label="Docs" icon={FileText} count={0} active={view === "docs"} open={isOpen} />
          <Entry view="browsers" label="Browsers" icon={Globe} count={browsing} active={view === "browsers"} open={isOpen} />
          <Entry view="restrictions" label="Restrictions" icon={ShieldCheck} count={0} active={view === "restrictions"} open={isOpen} />
        </div>
        {pins.length > 0 && (
          <div data-agent="sidebar-pinned" className="mt-3 flex min-h-0 flex-col gap-0.5 overflow-y-auto [scrollbar-width:none]">
            {isOpen ? <p className="shrink-0 px-2.5 pb-1 text-xs font-medium text-muted-foreground">Pinned</p> : <span className="mx-2.5 mb-1.5 h-px shrink-0 bg-border" />}
            {pins.map(t => (
              <PinnedEntry key={t.id} t={t} open={isOpen} unread={unseenDeep(t, threads)} onDrop={dropPin(t.id)} />
            ))}
          </div>
        )}
        <CursorToggle open={isOpen} />
        <ResourceReadout open={isOpen} />
        {isOpen && <div onPointerDown={e => dragToResize(e, saved.width, setSaved)} title={saved.pinned ? "Drag to resize · ⌘\\ to unpin" : "Drag to resize · ⌘\\ to pin open"} className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize" />}
      </nav>
    </div>
  );
}
