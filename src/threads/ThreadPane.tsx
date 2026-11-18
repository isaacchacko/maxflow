import { ArrowLeft, Ellipsis, Maximize2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { threadStore } from "@/store";
import { closePane, openPane, paneStore, paneWidth, savePaneWidth } from "./pane";
import { landOn } from "./jump";
import { ThreadNavContext, ThreadPage, type ThreadNav } from "./ThreadPage";
import { focusRegion } from "./vim";

/**
 * Slack's side pane: the thread he shift-clicked, beside the page, with everything a thread page does. Subthreads open inside it,
 * climbing out of a subthread goes back to its parent here, and climbing out of the thread closes it; ⋯ opens it in full. Like
 * Slack's, it is set off from the page by a soft shadow on its edge rather than a rule, and headed "Thread" with its title beside.
 */
export function ThreadPane() {
  const id = paneStore.use();
  const all = threadStore.use();
  const [width, setWidth] = useState(paneWidth);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => !(e.target as Element).closest("[data-agent=pane-menu]") && setMenu(false);
    addEventListener("mousedown", away);
    return () => removeEventListener("mousedown", away);
  }, [menu]);
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
    if (m && !e.metaKey && !e.ctrlKey && !e.shiftKey && !(e.target as Element).closest("[data-agent=pane-open-full]")) (e.preventDefault(), e.stopPropagation(), openPane(m[1]!));
  };

  return (
    <aside data-region="pane" data-agent="thread-pane" style={{ width }} onClickCapture={keepInside} className="relative z-[1] flex h-full shrink-0 flex-col border-l border-border/60 shadow-[-6px_0_14px_-8px_rgb(0_0_0/0.18)]">
      <div onPointerDown={drag} title="Drag to resize" className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" />
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b px-3">
        {parent && (
          <button aria-label="Back to the thread" title="Back to the thread" onClick={() => nav.up(id, "")} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <ArrowLeft className="size-4" />
          </button>
        )}
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-[15px] font-bold">Thread</span>
          <span title={thread?.title} className={cn("min-w-0 truncate text-xs text-muted-foreground", thread?.resolved && "line-through")}>{thread?.title}</span>
        </h2>
        <span data-agent="pane-menu" className="relative">
          <button aria-label="More" title="More" aria-expanded={menu} onClick={() => setMenu(o => !o)} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <Ellipsis className="size-4" />
          </button>
          {menu && (
            <div className="absolute top-8 right-0 z-30 w-44 rounded-xl border bg-card p-1 shadow-card">
              <a href={`#thread/${id}`} onClick={() => setMenu(false)} data-agent="pane-open-full" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted">
                <Maximize2 className="size-3.5 text-muted-foreground" />
                Open in full
              </a>
            </div>
          )}
        </span>
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
