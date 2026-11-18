import { ArrowLeft, Maximize2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { threadStore } from "@/store";
import { closePane, openPane, paneStore, paneWidth, savePaneWidth } from "./pane";
import { landOn } from "./jump";
import { ThreadNavContext, ThreadPage, type ThreadNav } from "./ThreadPage";
import { focusRegion } from "./vim";

/**
 * Slack's side pane: the thread he shift-clicked, beside the page, with everything a thread page does. Subthreads open inside it,
 * climbing out of a subthread goes back to its parent here, and climbing out of the thread closes it; ↗ opens it in full.
 */
export function ThreadPane() {
  const id = paneStore.use();
  const all = threadStore.use();
  const [width, setWidth] = useState(paneWidth);
  const nav = useMemo<ThreadNav>(
    () => ({
      open: openPane,
      up: threadId => {
        const t = threadStore.get().find(x => x.id === threadId);
        if (!t?.parentId) return closePane();
        landOn(t.parentMessageId);
        openPane(t.parentId);
      },
    }),
    [],
  );
  // Opening takes the keys, so j/k and Esc work in it at once.
  useEffect(() => focusRegion(id ? "pane" : "main"), [id]);
  if (!id) return null;
  const thread = all.find(t => t.id === id);
  const parent = thread?.parentId;

  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = e.clientX + width;
    let w = width;
    const move = (m: PointerEvent) => setWidth((w = Math.max(320, Math.min(innerWidth * 0.6, start - m.clientX))));
    const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up), savePaneWidth(w));
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  // A link to a thread inside the pane opens there, as Slack's does; anything else goes to the page.
  const keepInside = (e: React.MouseEvent) => {
    const href = (e.target as Element).closest("a")?.getAttribute("href");
    const m = href?.match(/^#thread\/(.+)$/);
    if (m && !e.metaKey && !e.ctrlKey && !e.shiftKey) (e.preventDefault(), e.stopPropagation(), openPane(m[1]!));
  };

  return (
    <aside data-region="pane" data-agent="thread-pane" style={{ width }} onClickCapture={keepInside} className="relative flex h-full shrink-0 flex-col border-l">
      <div onPointerDown={drag} title="Drag to resize" className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" />
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b px-3">
        {parent && (
          <button aria-label="Back to the thread" title="Back to the thread" onClick={() => nav.up(id, "")} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <ArrowLeft className="size-4" />
          </button>
        )}
        <h2 className={cn("min-w-0 flex-1 truncate text-sm font-semibold", thread?.resolved && "text-muted-foreground")}>{thread?.title ?? "Thread"}</h2>
        <a href={`#thread/${id}`} title="Open in full" aria-label="Open in full" data-agent="pane-open-full" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Maximize2 className="size-4" />
        </a>
        <button onClick={closePane} title="Close (Esc)" aria-label="Close" data-agent="pane-close" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <ThreadNavContext.Provider value={nav}>
          <ThreadPage key={id} id={id} back="" embedded />
        </ThreadNavContext.Provider>
      </div>
    </aside>
  );
}
