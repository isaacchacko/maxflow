import { ArrowLeft, Ellipsis, Maximize2, MessageSquareReply, X } from "lucide-react";
import { useMemo, useState } from "react";
import { cn, hasText } from "@/lib/utils";
import type { Thread } from "@/mock";
import { threadStore } from "@/store";
import { closePane, openPane, paneStore, paneWidth, savePaneWidth } from "./pane";
import { landOn } from "./jump";
import { openPause } from "./Pause";
import { DropMenu, RowMenu, threadItems, type MenuItem } from "./RowMenu";
import { resolveOrReopen, ThreadNavContext, ThreadPage, type ThreadNav } from "./ThreadPage";
import { AgentStack } from "./ThreadPanel";
import { PinToggle } from "./PinToggle";

const openThreadInFull = (id: string) => {
  location.hash = `#thread/${id}`;
};

function dragToResize(e: React.PointerEvent, startWidth: number, setWidth: (width: number) => void) {
  e.preventDefault();
  const start = e.clientX + startWidth;
  let width = startWidth;
  const move = (m: PointerEvent) => {
    width = Math.max(320, Math.min(innerWidth * 0.6, start - m.clientX));
    setWidth(width);
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    savePaneWidth(width);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

function keepThreadLinksInPane(e: React.MouseEvent) {
  if (!(e.target instanceof Element)) return;
  const href = e.target.closest("a")?.getAttribute("href");
  const threadId = /^#thread\/(.+)$/.exec(href ?? "")?.[1];
  const isModified = e.metaKey || e.ctrlKey || e.shiftKey;
  if (threadId === undefined || isModified || e.target.closest("[data-agent=pane-open-full]")) return;
  e.preventDefault();
  e.stopPropagation();
  openPane(threadId);
}

export function ThreadPane() {
  const id = paneStore.use();
  const all = threadStore.use();
  const [width, setWidth] = useState(paneWidth);

  const nav = useMemo<ThreadNav>(
    () => ({
      open: openPane,
      up: threadId => {
        const t = threadStore.get().find(x => x.id === threadId);
        if (t === undefined || !hasText(t.parentId)) {
          closePane();
          return;
        }
        landOn(t.parentMessageId);
        openPane(t.parentId);
      },
    }),
    [],
  );
  if (!hasText(id)) return null;
  const thread = all.find(t => t.id === id);
  const parent = thread?.parentId;
  const climb = () => nav.up(id, "");
  const resolve = (t: Thread) => {
    void resolveOrReopen(t, climb);
  };
  const items: (MenuItem | false | undefined)[] = [
    { label: "Open in full", icon: Maximize2, run: () => openThreadInFull(id), agent: "pane-open-full" },
    { label: "Reply", icon: MessageSquareReply, run: () => document.querySelector<HTMLElement>('[data-agent="thread-pane"] [data-agent="thread-input"]')?.focus() },
    ...(thread ? threadItems(thread, all, { resolve: () => resolve(thread), pause: () => openPause(thread.id, climb) }) : []),
  ];

  return (
    <aside data-region="pane" data-agent="thread-pane" style={{ width }} onClickCapture={keepThreadLinksInPane} className="relative z-[1] flex h-full shrink-0 flex-col border-l border-border/60 shadow-[-6px_0_14px_-8px_rgb(0_0_0/0.18)]">
      <div onPointerDown={e => dragToResize(e, width, setWidth)} title="Drag to resize" className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" />
      <RowMenu agent="pane-header" items={items}>
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b px-3">
        {hasText(parent) && (
          <button aria-label="Back to the thread" title="Back to the thread" onClick={() => nav.up(id, "")} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <ArrowLeft className="size-4" />
          </button>
        )}
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium">Thread</span>
          <span title={thread?.title} className={cn("min-w-0 truncate text-xs text-muted-foreground", thread?.resolved && "line-through")}>{thread?.title}</span>
        </h2>
        {thread && <AgentStack thread={thread} />}
        {thread && <PinToggle thread={thread} className="size-7" />}
        <DropMenu agent="pane" items={items}>
          <button data-agent="pane-menu" aria-label="More" title="More" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted">
            <Ellipsis className="size-4" />
          </button>
        </DropMenu>
        <button onClick={closePane} title="Close (Esc)" aria-label="Close" data-agent="pane-close" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-4" />
        </button>
      </header>
      </RowMenu>
      <div className="min-h-0 flex-1">
        <ThreadNavContext.Provider value={nav}>
          <ThreadPage key={id} id={id} back="" embedded />
        </ThreadNavContext.Provider>
      </div>
    </aside>
  );
}
