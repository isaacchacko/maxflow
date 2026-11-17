import { AlarmClock, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { card, surface } from "@/lib/surface";
import { cn } from "@/lib/utils";
import { openTab } from "@/tabs";
import type { Thread } from "@/mock";
import { markAskShown, objectiveStore, setResolved, startThread, threadStore } from "@/store";
import { Composer } from "@/threads/Composer";
import { arrivedFrom, composeOnArrival, flash, useLayerScroll } from "@/threads/jump";
import { MessageRow } from "@/threads/MessageRow";
import { FeedTag } from "@/threads/FeedTag";
import { Replies } from "@/threads/Replies";
import { RowMenu, threadItems } from "@/threads/RowMenu";
import { ShotScope, shotsOf } from "@/threads/Viewer";
import { freshlyBack, openPause, pausedLabel } from "@/threads/Pause";
import { unseenDeep, useSeen } from "@/threads/seen";
import { useVim, vimRow } from "@/threads/vim";

/** A thread asks for Isaac from the first message after his last reply; null once he has answered everything in it. */
function askedAt(t: Thread) {
  const lastMine = t.messages.findLastIndex(m => m.from === "isaac");
  const ask = t.messages.slice(lastMine + 1)[0];
  return ask ? Date.parse(ask.at) : null;
}

export function InboxView() {
  const threads = threadStore.use();
  const objectives = objectiveStore.use();
  const [showResolved, setShowResolved] = useState(false);
  // Resolved from this list, a row stays put until he leaves the inbox, so a second click undoes an accidental resolve.
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  // Subthreads live under their message, not in the inbox.
  const tops = threads.filter(t => !t.parentId);
  const resolved = tops.filter(t => t.resolved).length;
  // Paused, a thread is out of the inbox behind its own toggle until its time comes round, as resolved ones are.
  const [showPaused, setShowPaused] = useState(false);
  const paused = tops.filter(t => t.paused).length;
  useSeen();
  const rows = tops
    .filter(t => (showResolved || !t.resolved || kept.has(t.id)) && (showPaused || !t.paused || kept.has(t.id)))
    .map(t => ({ t, asked: askedAt(t), last: Date.parse(t.messages.at(-1)?.at ?? "") || 0, back: freshlyBack(t, unseenDeep(t, threads)) }))
    // An agent waiting on him comes first, longest-waiting on top, then what just came back from a pause.
    .sort((a, b) => Number(!a.t.asks) - Number(!b.t.asks) || Number(!a.back) - Number(!b.back) || (a.asked ?? Infinity) - (b.asked ?? Infinity) || b.last - a.last);
  // An agent waiting on him stays on top of everything.
  const needsYou = rows.filter(r => r.t.asks);
  const others = rows.filter(r => !r.t.asks);
  const toggle = (t: Thread) => (setKept(k => new Set(k).add(t.id)), setResolved(t.id, !t.resolved));
  // Drawing an ask flagged, on a page he has in front of him, starts the clock on its agent's default.
  const unshown = rows.filter(r => r.t.asks && !r.t.asks.shown).map(r => r.t.id);
  useEffect(() => {
    if (document.visibilityState === "visible") for (const id of unshown) markAskShown(id);
  }, [unshown.join()]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const open = (id: string) => (location.hash = `thread/${id}`);
  const reply = (id: string) => (composeOnArrival(), (location.hash = `thread/${id}`));
  // Right-click offers what the keys do, on the row it was clicked on.
  // Paused from this list, a row stays put like a resolved one, so he sees it took.
  const pause = (id: string) => (setKept(k => new Set(k).add(id)), openPause(id));
  const menu = (t: Thread) => threadItems(t, threads, { open: () => open(t.id), reply: () => reply(t.id), resolve: () => toggle(t), pause: () => pause(t.id) });
  // j/k walk the page in reading order: the asks, then the threads.
  const vim = useVim("inbox", [...needsYou, ...others].map(r => r.t.id), scrollRef, "first", {
    compose: () => document.querySelector<HTMLElement>('[data-agent="inbox-input"]')?.focus(),
    open,
    tab: id => openTab(`thread/${id}`, true),
    reply,
    resolve: id => {
      const t = threads.find(x => x.id === id);
      if (t) toggle(t);
    },
    pause: id => id && pause(id),
  });
  // Back up out of a thread, the list is where he left it, and that thread's row takes the cursor and flashes.
  useLayerScroll("inbox", scrollRef);
  useEffect(() => {
    const from = arrivedFrom();
    const row = from && scrollRef.current?.querySelector(`[data-vim="${CSS.escape(from)}"]`);
    if (row) vim.move(from, false), flash(row);
  }, []);

  const threadRow = (t: Thread) => {
      // A thread a router opened before writing in it shows its title as the opening message.
      const first = t.messages[0] ?? { from: t.routerIds[0] ?? t.objectiveId, at: "", text: t.title };
      return (
        <RowMenu key={t.id} agent={t.id} items={menu(t)}>
        <li {...vimRow(t.id)} className={cn("group relative px-3 py-2.5", card)}>
          <button
            data-agent={`inbox-resolve:${t.id}`}
            title={t.resolved ? "Reopen" : "Resolve"}
            onClick={() => toggle(t)}
            className={cn("absolute top-2.5 right-3 z-10 rounded-md border bg-card p-1 shadow-card hover:border-ring", t.resolved ? "text-ok" : "text-muted-foreground opacity-0 group-hover:opacity-100")}
          >
            <Check className="size-3.5" />
          </button>
          <div className={cn((t.resolved || t.paused) && "opacity-50")}>
            {/* An image in the preview opens the viewer over the whole thread's. */}
            <ShotScope.Provider value={shotsOf(t.messages)}>
            <MessageRow
              from={first.from}
              at={first.at}
              text={first.text}
              active={vim.cursor === t.id}
              className="cursor-pointer"
              // A long opener or a pasted screenshot stays a preview here; the thread has it in full.
              bodyClassName="max-h-36 overflow-hidden [&_img]:max-h-28"
              // The whole row opens the thread, except the links and chips inside the message.
              onClick={e => (e.target as Element).closest("a") || (location.hash = `thread/${t.id}`)}
              meta={
                <span className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
                  {t.asks && <span className="shrink-0 rounded-full bg-warn-soft px-2 font-medium text-warn">needs you</span>}
                  {t.feed && <FeedTag feed={t.feed} />}
                  <span className="truncate">{t.objectiveId ? objectives.find(o => o.id === t.objectiveId)?.title : t.asks ? "" : "routing…"}</span>
                  {t.resolved && <Check className="size-3 shrink-0 self-center" />}
                  {t.paused && (
                    <span data-agent={`inbox-paused:${t.id}`} className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                      <AlarmClock className="size-3 self-center" />
                      {pausedLabel(t.paused)}
                    </span>
                  )}
                </span>
              }
            >
              <Replies t={t} />
            </MessageRow>
            </ShotScope.Provider>
          </div>
        </li>
        </RowMenu>
      );
  };

  return (
    <div ref={scrollRef} className="flex h-full gap-6 overflow-y-auto p-4">
      {vim.panel}
      <div className="flex max-w-4xl min-w-0 shrink basis-4xl flex-col gap-3">
        <Composer autoFocus agent="inbox-input" draftKey="inbox" onSend={startThread} className="rounded-2xl border bg-card px-3.5 py-3 shadow-raised" />
        {(resolved > 0 || paused > 0) && (
        <div className="flex gap-2">
        {resolved > 0 && (
          <button data-agent="inbox-resolved" onClick={() => setShowResolved(v => !v)} className={cn("flex w-fit items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs text-muted-foreground hover:border-ring", showResolved && "border-ring text-foreground")}>
            <Check className="size-3" />
            Resolved ({resolved})
          </button>
        )}
        {paused > 0 && (
          <button data-agent="inbox-paused" onClick={() => setShowPaused(v => !v)} className={cn("flex w-fit items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs text-muted-foreground hover:border-ring", showPaused && "border-ring text-foreground")}>
            <AlarmClock className="size-3" />
            Paused ({paused})
          </button>
        )}
        </div>
        )}
        {needsYou.length > 0 && <ol className={cn(surface, "bg-warn-soft/70")}>{needsYou.map(({ t }) => threadRow(t))}</ol>}
        <ol className={cn(surface, "empty:hidden")}>{others.map(({ t }) => threadRow(t))}</ol>
      </div>
    </div>
  );
}
