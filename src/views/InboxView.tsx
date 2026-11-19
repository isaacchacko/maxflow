import { AlarmClock, ArrowUpToLine, Check, ChevronDown, MessageSquareReply, Pin, Quote, RotateCcw } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Fragment, useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { localAt, type Thread } from "@/mock";
import { markAskShown, movedStore, objectiveStore, setResolved, startThread, threadStore } from "@/store";
import { Composer, quoteInto, quoted } from "@/threads/Composer";
import { HoverBar } from "@/threads/HoverBar";
import { MovedChip } from "@/threads/Moved";
import { arrivedFrom, composeOnArrival, flash, goToMessage, useLayerScroll } from "@/threads/jump";
import { MessageRow } from "@/threads/MessageRow";
import { Replies } from "@/threads/Replies";
import { Avatar, Rich } from "@/threads/Rich";
import { pinItem, RowMenu, threadItems } from "@/threads/RowMenu";
import { openRaise } from "@/threads/Raise";
import { ShotScope, shotsOf } from "@/threads/Viewer";
import { openPause, pausedLabel } from "@/threads/Pause";
import { unseenDeep, useSeen } from "@/threads/seen";

// The inbox is one channel, as Slack draws one: every thread's opening message, oldest at the top, under day dividers, with its
// replies line; the box to start a thread sits at the bottom. Threads keep their place when replies come in.

const GROUP_MS = 5 * 60_000;
const SEEN_AT = "inbox-seen-at";

/** A thread's opening message; a thread a router opened before writing in it shows its title, at the bottom until it does. */
// A feed thread opens on its first new message, not the context before it.
const openerOf = (t: Thread): Thread["messages"][number] => t.messages.find(m => !m.ext?.context) ?? t.messages[0] ?? { from: t.routerIds[0] ?? t.objectiveId, at: t.pending?.since ?? "9999", text: t.title };

function dayLabel(day: string) {
  const d = new Date(`${day}T00:00`);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
}

/**
 * Slack's day divider: a hairline across the whole list where the day starts, with the day as a white pill on it. The line scrolls
 * away with the day; the pill alone sticks to the top while that day scrolls by, floating over the rows (with a soft shadow then),
 * and opens a jump-to menu: a week back, or any day in the channel. The line is the `data-day` mark the pill is placed against.
 */
function DayDivider({ day, days, jump }: { day: string; days: string[]; jump(day: string): void }) {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toLocaleDateString("sv");
  const lastWeek = [...days].reverse().find(d => d >= weekAgo && d < new Date(Date.now() - 86_400_000).toLocaleDateString("sv"));
  const item = "flex cursor-pointer items-center justify-between gap-6 px-2 py-1 outline-none select-none data-highlighted:bg-muted";
  return (
    <>
      <div data-day={day} className="-mx-5 mt-5 h-px bg-border" />
      {/* Only the pill takes clicks: the rows it floats over stay clickable on either side of it. */}
      <div data-agent="inbox-day" className="group/day pointer-events-none sticky top-1.5 z-20 -mt-3 mb-1.5 flex justify-center">
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger data-agent="inbox-day-jump" className="pointer-events-auto flex items-center gap-1 rounded-full border bg-card px-3 py-0.5 text-xs font-medium text-foreground outline-none group-data-stuck/day:shadow-[0_2px_6px_rgb(0_0_0/0.08)] hover:bg-muted data-[state=open]:bg-muted">
            {dayLabel(day)}
            <ChevronDown className="size-3 text-muted-foreground" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="center" sideOffset={4} onEscapeKeyDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onCloseAutoFocus={e => e.preventDefault()} className="z-50 max-h-80 min-w-44 overflow-y-auto border bg-background p-1 text-sm shadow-lg">
              <DropdownMenu.Label className="px-2 py-1 text-xs text-muted-foreground">Jump to…</DropdownMenu.Label>
              {lastWeek && (
                <DropdownMenu.Item className={item} onSelect={() => jump(lastWeek)}>
                  Last week <span className="text-xs text-muted-foreground">{dayLabel(lastWeek)}</span>
                </DropdownMenu.Item>
              )}
              {days.map(d => (
                <DropdownMenu.Item key={d} data-agent={`inbox-day-to:${d}`} className={cn(item, d === day && "font-medium")} onSelect={() => jump(d)}>
                  {dayLabel(d)}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </>
  );
}

/** When he last had the inbox open, kept in this browser; what opened after it sits under the red "New" line. */
function useSeenAt() {
  const [at] = useState(() => {
    try {
      return localStorage.getItem(SEEN_AT) ?? localAt();
    } catch {
      return localAt();
    }
  });
  return at;
}
const markSeenAt = () => {
  try {
    localStorage.setItem(SEEN_AT, localAt());
  } catch {}
};
/** On the inbox's frame: he has it open from when it is drawn until it goes. */
const openInbox = (frame: HTMLElement) => {
  markSeenAt();
  return markSeenAt;
};

/** Drawing an ask flagged, on a page he has in front of him, starts the clock on its agent's default. */
const askDrawn = (row: HTMLElement | null) => {
  if (row && document.visibilityState === "visible") markAskShown(row.dataset.ask!);
};

export function InboxView() {
  const threads = threadStore.use();
  const objectives = objectiveStore.use();
  const [showResolved, setShowResolved] = useState(false);
  // Resolved or paused from this list, a row stays put until he leaves the inbox, so a second click undoes an accidental one.
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  // Subthreads live under their message, not in the inbox. A thread of his merged into another stays as a stub where it was.
  const tops = [...threads.filter(t => !t.parentId), ...movedStore.use()];
  const resolved = tops.filter(t => t.resolved).length;
  const [showPaused, setShowPaused] = useState(false);
  const paused = tops.filter(t => t.paused).length;
  useSeen();
  const seenAt = useSeenAt();
  const rows = tops
    .filter(t => (showResolved || !t.resolved || kept.has(t.id)) && (showPaused || !t.paused || kept.has(t.id)))
    .map(t => ({ t, first: openerOf(t) }))
    .sort((a, b) => a.first.at.localeCompare(b.first.at));
  const asks = rows.filter(r => r.t.asks);
  const replied = rows.filter(r => unseenDeep(r.t, threads) > 0);
  const firstNew = rows.findIndex(r => r.first.from !== "isaac" && r.first.at > seenAt);
  const toggle = (t: Thread) => {
    setKept(k => new Set(k).add(t.id));
    setResolved(t.id, !t.resolved).catch(() => {});
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const open = (id: string) => (location.hash = `thread/${id}`);
  const reply = (id: string) => (composeOnArrival(), (location.hash = `thread/${id}`));
  const pause = (id: string) => (setKept(k => new Set(k).add(id)), openPause(id));
  // Quoting an opener answers it in its thread: the quote waits in that thread's box, which opens focused on it.
  const quote = (id: string) => {
    const t = threads.find(x => x.id === id);
    const m = t?.messages[0];
    if (t && m?.id) quoteInto(`thread:${t.id}`, quoted(m.text, t.id, m.id)), open(t.id);
  };
  const menu = (t: Thread) => threadItems(t, threads, { open: () => open(t.id), reply: () => reply(t.id), resolve: () => toggle(t), pause: () => pause(t.id) });
  const show = (id: string) => {
    const row = scrollRef.current?.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (row) flash(row);
  };

  // Opening, it lands where he left it when coming back, on the thread he climbed out of, on the "New" line, or at the bottom.
  const atBottom = useRef(true);
  const attachScroll = useLayerScroll("inbox", scrollRef, (el, restored) => {
    const from = arrivedFrom();
    if (!restored) {
      if (lineRef.current) el.scrollTop = lineRef.current.offsetTop - 48;
      else el.scrollTop = el.scrollHeight;
    }
    onScroll();
    if (from) show(from);
  });
  // A new thread lands at the bottom, and the channel follows it there when he was already at the bottom. On opening the
  // scroller isn't attached yet, and its arrival above decides where to land.
  const endOfInbox = useCallback(
    (end: HTMLElement | null) => {
      const el = scrollRef.current;
      if (end && el && atBottom.current) el.scrollTop = el.scrollHeight;
    },
    [rows.length],
  );
  function onScroll() {
    const el = scrollRef.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // A day's pill is stuck once the line where its day starts has scrolled up past where the pill sits.
    const top = el.getBoundingClientRect().top;
    for (const mark of el.querySelectorAll<HTMLElement>("[data-day]")) mark.nextElementSibling?.toggleAttribute("data-stuck", mark.getBoundingClientRect().top < top + 6);
  }
  // The channel's days in order, as runs of its rows: [from, to) in rows.
  const sections = rows.reduce<{ day: string; from: number; to: number }[]>((all, r, i) => {
    const day = r.first.at.slice(0, 10);
    if (all.at(-1)?.day === day) all.at(-1)!.to = i + 1;
    else all.push({ day, from: i, to: i + 1 });
    return all;
  }, []);
  // The days in the channel, newest first, for the dividers' jump-to menu; a jump lands on the day's first thread under its bar.
  const days = [...new Set(rows.map(r => r.first.at.slice(0, 10)).filter(d => d !== "9999"))].reverse();
  const jump = (day: string) => {
    const el = scrollRef.current;
    const mark = el?.querySelector(`[data-day="${day}"]`);
    if (el && mark) el.scrollTop += mark.getBoundingClientRect().top - el.getBoundingClientRect().top;
  };

  // The bar at the top steps through the threads with replies he hasn't seen, in the channel's order.
  const [step, setStep] = useState(0);
  const nextReplied = () => {
    const r = replied[step % replied.length];
    if (r) show(r.t.id), setStep(s => s + 1);
  };

  const movedRow = (t: Thread, to: NonNullable<Thread["movedTo"]>, first: ReturnType<typeof openerOf>) => (
    <div key={t.id} data-row={t.id} data-agent={`inbox-moved:${t.id}`} className="group/row group/bar relative mt-2.5">
      <div className="opacity-60">
        <MessageRow
          from={first.from}
          at={first.at}
          text={first.text}
          grouped={false}
          className="cursor-pointer"
          bodyClassName="max-h-36 overflow-hidden [&_img]:max-h-28"
          onClick={e => {
            if (!(e.target as Element).closest("a, button")) goToMessage(to.id, to.messageId);
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <MovedChip to={to} />
            {t.resolved && (
              <button data-agent={`inbox-reopen:${t.id}`} title="Reopen" onClick={() => toggle(t)} className="mt-1 flex items-center gap-1 rounded-full border border-ok/40 bg-ok/10 px-2 py-0.5 text-xs font-medium text-ok hover:border-ok">
                <Check className="size-3" />
                Resolved
              </button>
            )}
          </div>
        </MessageRow>
      </div>
      <HoverBar agent={t.id} actions={[{ label: t.resolved ? "Reopen" : "Resolve", icon: t.resolved ? RotateCcw : Check, run: () => toggle(t), agent: `inbox-resolve:${t.id}` }]} menu={[]} />
    </div>
  );

  const threadRow = (t: Thread, first: ReturnType<typeof openerOf>, grouped: boolean) => (
    <RowMenu key={t.id} agent={t.id} items={menu(t)}>
      <div data-row={t.id} className={cn("group/row group/bar relative", !grouped && "mt-2.5")}>
        <div className={cn((t.resolved || t.paused) && "opacity-50")}>
          {/* An image in the preview opens the viewer over the whole thread's. */}
          <ShotScope.Provider value={shotsOf(t.messages)}>
            <MessageRow
              from={first.from}
              at={first.at}
              text={first.text}
              ext={first.ext}
              grouped={grouped}
              className="cursor-pointer"
              // A long opener or a pasted screenshot stays a preview here; the thread has it in full.
              bodyClassName="max-h-36 overflow-hidden [&_img]:max-h-28"
              // The whole row opens the thread, except the links and chips inside the message.
              onClick={e => (e.target as Element).closest("a, button") || open(t.id)}
              meta={
                <span className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
                  {t.pinned && <Pin aria-label="pinned" className="size-3 shrink-0 self-center text-muted-foreground" />}
                  {t.asks && <span className="shrink-0 rounded-full bg-warn-soft px-2 font-medium text-warn">needs you</span>}
                  <span className="truncate">{t.objectiveId ? objectives.find(o => o.id === t.objectiveId)?.title : t.asks ? "" : "routing…"}</span>
                  {t.paused && (
                    <span data-agent={`inbox-paused:${t.id}`} title={pausedLabel(t.paused)} className="flex min-w-0 items-center gap-1 whitespace-nowrap">
                      <AlarmClock className="size-3 shrink-0 self-center" />
                      <span className="min-w-0 truncate">{pausedLabel(t.paused)}</span>
                    </span>
                  )}
                </span>
              }
            >
              {/* Resolved, the row says so beside its replies, and the pill reopens it. */}
              {((t.messages.length > 1 || t.pending || grouped) || t.resolved) && (
                <div className="flex flex-wrap items-center gap-2">
                  {(t.messages.length > 1 || t.pending || grouped) && <Replies t={t} />}
                  {t.resolved && (
                    <button data-agent={`inbox-reopen:${t.id}`} title="Reopen" onClick={() => toggle(t)} className="mt-1 flex items-center gap-1 rounded-full border border-ok/40 bg-ok/10 px-2 py-0.5 text-xs font-medium text-ok hover:border-ok">
                      <Check className="size-3" />
                      Resolved
                    </button>
                  )}
                </div>
              )}
            </MessageRow>
          </ShotScope.Provider>
        </div>
        <HoverBar
          agent={t.id}
          actions={[
            { label: t.resolved ? "Reopen" : "Resolve", icon: t.resolved ? RotateCcw : Check, run: () => toggle(t), agent: `inbox-resolve:${t.id}` },
            { label: t.paused ? "Pause again…" : "Pause…", icon: AlarmClock, run: () => pause(t.id), agent: `inbox-pause:${t.id}` },
            { label: "Reply in thread", icon: MessageSquareReply, run: () => reply(t.id), agent: `inbox-reply:${t.id}` },
            !!t.messages[0]?.id && { label: "Quote", icon: Quote, run: () => quote(t.id), agent: `inbox-quote:${t.id}` },
            !!t.messages[0]?.id && { label: "Raise to Threads", icon: ArrowUpToLine, run: () => openRaise(t.id, t.messages[0]!.id!, t.messages[0]!.text), agent: `inbox-raise:${t.id}` },
            pinItem(t),
          ]}
          menu={menu(t)}
        />
      </div>
    </RowMenu>
  );

  const rowOf = (t: Thread, first: ReturnType<typeof openerOf>, isGrouped: boolean) => (t.movedTo ? movedRow(t, t.movedTo, first) : threadRow(t, first, isGrouped));

  return (
    <div ref={openInbox} className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-5">
            <h1 className="text-sm font-medium">Threads</h1>
            {replied.length > 0 && (
              <button data-agent="inbox-new-replies" onClick={nextReplied} className="flex items-center gap-1.5 rounded-full bg-new-soft px-2.5 py-0.5 text-xs font-medium text-new hover:brightness-95">
                <ChevronDown className="size-3" />
                {replied.length === 1 ? "1 thread with new replies" : `${replied.length} threads with new replies`}
              </button>
            )}
            <span className="ml-auto" />
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
        </header>
        {/* Agents waiting on him, pinned above the channel one line each; a click scrolls to the thread where it sits. */}
        {asks.length > 0 && (
          <ol data-agent="inbox-asks" className="flex shrink-0 flex-col border-b bg-warn-soft/40 px-3 py-1">
            {asks.map(({ t, first }) => (
              <li key={t.id} data-ask={t.id} ref={t.asks!.shown ? undefined : askDrawn}>
                <button onClick={() => show(t.id)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-black/[0.04]">
                  <Avatar from={first.from} small />
                  <span className="shrink-0 rounded-full bg-card px-2 text-xs font-medium text-warn">needs you</span>
                  <Rich still text={(t.messages.findLast(m => m.from !== "isaac") ?? first).text.split("\n")[0] ?? t.title} className="min-w-0 truncate" />
                </button>
              </li>
            ))}
          </ol>
        )}
        <section className="flex min-h-0 flex-1 flex-col">
          <div ref={attachScroll} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-5 pt-0 pb-4">
            {/* Each day is a section of its own, so its pill sticks only while the day is on screen and the next day's pushes it
                off: one pill at the top at a time, as in Slack. */}
            {sections.map(({ day, from, to }) => (
              <section key={day} data-agent="inbox-day-section">
                {day !== "9999" && <DayDivider day={day} days={days} jump={jump} />}
                {rows.slice(from, to).map(({ t, first }, j) => {
                  const i = from + j;
                  const prev = rows[i - 1];
                  const isNew = i === firstNew;
                  const grouped = j > 0 && !isNew && !t.asks && !t.feed && !t.paused && !prev?.t.asks && prev?.first.from === first.from && Date.parse(first.at) - Date.parse(prev.first.at) <= GROUP_MS;
                  return (
                    <Fragment key={t.id}>
                      {isNew && (
                        <div ref={lineRef} data-agent="unread-line" className="my-2 flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
                          <span className="h-px flex-1 bg-destructive" />
                          New
                        </div>
                      )}
                      {rowOf(t, first, grouped)}
                    </Fragment>
                  );
                })}
              </section>
            ))}
            <div ref={endOfInbox} />
          </div>
          <Composer autoFocus agent="inbox-input" draftKey="inbox" placeholder="Message Threads" onSend={text => ((atBottom.current = true), startThread(text))} className="px-4 pt-1 pb-3" />
        </section>
    </div>
  );
}
