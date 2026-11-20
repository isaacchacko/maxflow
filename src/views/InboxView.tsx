import { AlarmClock, Check, CheckCheck, ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useCallback, useRef, useState } from "react";
import { FitLabel, FitRow } from "@/components/Fit";
import { cn, hasText } from "@/lib/utils";
import { localAt, type Objective, type Thread } from "@/mock";
import { markAskShown, movedStore, objectiveStore, setResolved, startThread, threadStore } from "@/store";
import { Composer, quoteInto, quoted } from "@/threads/Composer";
import { arrivedFrom, composeOnArrival, flash, useLayerScroll } from "@/threads/jump";
import { openPause } from "@/threads/Pause";
import { Avatar, Rich } from "@/threads/Rich";
import { threadItems } from "@/threads/RowMenu";
import { unseenDeep, useSeen } from "@/threads/seen";
import { DayDivider } from "./inbox/DayDivider";
import { MovedRow, ThreadRow, type Message, type RowActions } from "./inbox/rows";

const GROUP_MS = 5 * 60_000;
const SEEN_AT = "inbox-seen-at";
const NOT_WRITTEN_YET = "9999";

type Row = { t: Thread; first: Message };
type DayRun = { day: string; from: number; to: number };

const titleUntilTheRouterWrites = (t: Thread): Message => ({ from: t.routerIds[0] ?? t.objectiveId, at: t.pending?.since ?? NOT_WRITTEN_YET, text: t.title });
const firstPastTheFeedContext = (t: Thread) => t.messages.find(m => m.ext?.context !== true);
const openerOf = (t: Thread): Message => firstPastTheFeedContext(t) ?? t.messages[0] ?? titleUntilTheRouterWrites(t);
const dayOfRow = (r: Row) => r.first.at.slice(0, 10);

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

function markSeenAt() {
  try {
    localStorage.setItem(SEEN_AT, localAt());
  } catch {
    // constraint: localStorage throws in a private window or on a full quota; the New line then starts from the last open that saved
  }
}

const openInboxUntilItGoes = () => {
  markSeenAt();
  return markSeenAt;
};

const startAskClockOnceSeen = (row: HTMLElement | null) => {
  const id = row?.dataset["ask"];
  if (hasText(id) && document.visibilityState === "visible") markAskShown(id);
};

const openThread = (id: string) => {
  location.hash = `thread/${id}`;
};

const replyInThread = (id: string) => {
  composeOnArrival();
  location.hash = `thread/${id}`;
};

function dayRuns(rows: Row[]) {
  const runs: DayRun[] = [];
  for (const [i, r] of rows.entries()) {
    const day = dayOfRow(r);
    const last = runs.at(-1);
    if (last?.day === day) last.to = i + 1;
    else runs.push({ day, from: i, to: i + 1 });
  }
  return runs;
}

function isGroupedWithPrevious(row: Row, prev: Row | undefined, isFirstOfDay: boolean, isNew: boolean) {
  const { t, first } = row;
  if (isFirstOfDay || isNew || !prev || t.asks || t.feed || t.paused || prev.t.asks) return false;
  return prev.first.from === first.from && Date.parse(first.at) - Date.parse(prev.first.at) <= GROUP_MS;
}

function NeedsYouStrip({ asks, onShow }: { asks: Row[]; onShow: (id: string) => void }) {
  if (asks.length === 0) return null;
  return (
    <ol data-agent="inbox-asks" className="flex shrink-0 flex-col border-b bg-warn-soft/40 px-3 py-1">
      {asks.map(({ t, first }) => (
        <li key={t.id} data-ask={t.id} ref={t.asks?.shown === true ? undefined : startAskClockOnceSeen}>
          <button onClick={() => onShow(t.id)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-black/[0.04]">
            <Avatar from={first.from} small />
            <span className="shrink-0 rounded-full bg-card px-2 text-xs font-medium text-warn">needs you</span>
            <Rich still text={(t.messages.findLast(m => m.from !== "isaac") ?? first).text.split("\n", 1)[0] ?? t.title} className="min-w-0 truncate" />
          </button>
        </li>
      ))}
    </ol>
  );
}

const awaitsHisConfirm = (t: Thread) => t.done !== undefined && !t.resolved;

function DoneConfirm({ done, onOpen }: { done: Thread[]; onOpen: (id: string) => void }) {
  const [isOpen, setOpen] = useState(false);
  if (done.length === 0) return null;
  const resolveAll = () => {
    for (const t of done) void setResolved(t.id, true);
  };
  return (
    <section data-agent="inbox-done" className="flex shrink-0 flex-col border-b px-3 py-1">
      <div className="flex items-center gap-2 px-2 py-1 text-sm">
        <button onClick={() => setOpen(v => !v)} className="flex min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground">
          {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="font-medium">Done, confirm ({done.length})</span>
        </button>
        <button data-agent="inbox-resolve-all" onClick={resolveAll} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs text-muted-foreground hover:border-ring hover:text-foreground">
          <CheckCheck className="size-3" />
          Resolve all
        </button>
      </div>
      {isOpen && (
        <ol className="flex flex-col pb-1">
          {done.map(t => (
            <li key={t.id} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-black/[0.04]">
              <button onClick={() => onOpen(t.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Avatar from={t.done?.by ?? ""} small />
                <span className="shrink-0 truncate font-medium">{t.title}</span>
                <Rich still text={t.done?.outcome ?? ""} className="min-w-0 truncate text-muted-foreground" />
              </button>
              <button onClick={() => void setResolved(t.id, true)} title="Resolve" aria-label={`Resolve ${t.title}`} className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-black/[0.06] hover:text-foreground">
                <Check className="size-3.5" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type FilterPill = { count: number; isOn: boolean; onToggle: () => void };

function InboxHeader({ replied, onNextReplied, resolved, paused }: { replied: number; onNextReplied: () => void; resolved: FilterPill; paused: FilterPill }) {
  const newReplies = replied === 1 ? "1 thread with new replies" : `${replied} threads with new replies`;
  const pill = "flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs text-muted-foreground hover:border-ring";
  return (
    <FitRow className="h-12 shrink-0 items-center gap-2 border-b px-5">
      <h1 className="shrink-0 text-sm font-medium">Threads</h1>
      {replied > 0 && (
        <button data-agent="inbox-new-replies" onClick={onNextReplied} title={newReplies} aria-label={newReplies} className="flex shrink-0 items-center gap-1.5 rounded-full bg-new-soft px-2.5 py-0.5 text-xs font-medium text-new hover:brightness-95">
          <ChevronDown className="size-3" />
          <FitLabel full={newReplies} short={`${replied} new`} glyph={replied} />
        </button>
      )}
      <span className="ml-auto" />
      {resolved.count > 0 && (
        <button data-agent="inbox-resolved" onClick={resolved.onToggle} title={`Resolved (${resolved.count})`} aria-label={`Resolved (${resolved.count})`} className={cn(pill, resolved.isOn && "border-ring text-foreground")}>
          <Check className="size-3" />
          <FitLabel full={`Resolved (${resolved.count})`} glyph={resolved.count} />
        </button>
      )}
      {paused.count > 0 && (
        <button data-agent="inbox-paused" onClick={paused.onToggle} title={`Paused (${paused.count})`} aria-label={`Paused (${paused.count})`} className={cn(pill, paused.isOn && "border-ring text-foreground")}>
          <AlarmClock className="size-3" />
          <FitLabel full={`Paused (${paused.count})`} glyph={paused.count} />
        </button>
      )}
    </FitRow>
  );
}

type DayRunProps = { run: DayRun; rows: Row[]; firstNew: number; days: string[]; jump: (day: string) => void; lineRef: React.RefObject<HTMLDivElement | null>; objectives: Objective[]; actions: RowActions };

function DayRunSection({ run: { day, from, to }, rows, firstNew, days, jump, lineRef, objectives, actions }: DayRunProps) {
  return (
    <section data-agent="inbox-day-section">
      {day !== NOT_WRITTEN_YET && <DayDivider day={day} days={days} jump={jump} />}
      {rows.slice(from, to).map((row, j) => {
        const { t, first } = row;
        const i = from + j;
        const isNew = i === firstNew;
        const isGrouped = isGroupedWithPrevious(row, rows[i - 1], j === 0, isNew);
        return (
          <Fragment key={t.id}>
            {isNew && (
              <div ref={lineRef} data-agent="unread-line" className="my-2 flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
                <span className="h-px flex-1 bg-destructive" />
                New
              </div>
            )}
            {t.movedTo ? <MovedRow t={t} to={t.movedTo} first={first} onToggle={actions.toggle} /> : <ThreadRow t={t} first={first} isGrouped={isGrouped} objectives={objectives} actions={actions} />}
          </Fragment>
        );
      })}
    </section>
  );
}

function useInboxRows() {
  const threads = threadStore.use();
  const [isShowingResolved, setShowingResolved] = useState(false);
  const [isShowingPaused, setShowingPaused] = useState(false);
  const [keptWhileHere, setKeptWhileHere] = useState<Set<string>>(() => new Set());
  const topLevelAndMovedStubs = [...threads.filter(t => !hasText(t.parentId)), ...movedStore.use()];
  const isShown = (t: Thread) => (!awaitsHisConfirm(t) || keptWhileHere.has(t.id)) && (isShowingResolved || !t.resolved || keptWhileHere.has(t.id)) && (isShowingPaused || !t.paused || keptWhileHere.has(t.id));
  const rows = topLevelAndMovedStubs
    .filter(isShown)
    .map(t => ({ t, first: openerOf(t) }))
    .toSorted((a, b) => a.first.at.localeCompare(b.first.at));
  const keep = (id: string) => setKeptWhileHere(k => new Set(k).add(id));
  const resolved: FilterPill = { count: topLevelAndMovedStubs.filter(t => t.resolved).length, isOn: isShowingResolved, onToggle: () => setShowingResolved(v => !v) };
  const paused: FilterPill = { count: topLevelAndMovedStubs.filter(t => t.paused).length, isOn: isShowingPaused, onToggle: () => setShowingPaused(v => !v) };
  const done = topLevelAndMovedStubs.filter(awaitsHisConfirm);
  return { threads, rows, keep, resolved, paused, done };
}

function useRowActions(threads: Thread[], keep: (id: string) => void): RowActions {
  const toggle = (t: Thread) => {
    keep(t.id);
    void setResolved(t.id, !t.resolved);
  };
  const pause = (id: string) => {
    keep(id);
    openPause(id);
  };
  const quote = (id: string) => {
    const t = threads.find(x => x.id === id);
    const m = t?.messages[0];
    if (!t || !m || !hasText(m.id)) return;
    quoteInto(`thread:${t.id}`, quoted(m.text, t.id, m.id));
    openThread(t.id);
  };
  const menu = (t: Thread) => threadItems(t, threads, { open: () => openThread(t.id), reply: () => replyInThread(t.id), resolve: () => toggle(t), pause: () => pause(t.id) });
  return { open: openThread, reply: replyInThread, toggle, pause, quote, menu };
}

function markStuckDayPills(el: HTMLElement) {
  const top = el.getBoundingClientRect().top;
  for (const mark of el.querySelectorAll<HTMLElement>("[data-day]")) mark.nextElementSibling?.toggleAttribute("data-stuck", mark.getBoundingClientRect().top < top + 6);
}

function useInboxScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const show = (id: string) => {
    const row = scrollRef.current?.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (row) flash(row);
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    markStuckDayPills(el);
  };
  const attachScroll = useLayerScroll("inbox", scrollRef, (el, isRestored) => {
    const from = arrivedFrom();
    if (!isRestored) el.scrollTop = lineRef.current ? lineRef.current.offsetTop - 48 : el.scrollHeight;
    onScroll();
    if (hasText(from)) show(from);
  });
  const followNewThreadToBottom = useCallback((end: HTMLElement | null) => {
    const el = scrollRef.current;
    if (end && el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, []);
  const jump = (day: string) => {
    const el = scrollRef.current;
    const mark = el?.querySelector(`[data-day="${CSS.escape(day)}"]`);
    if (el && mark) el.scrollTop += mark.getBoundingClientRect().top - el.getBoundingClientRect().top;
  };
  const markAtBottom = () => {
    atBottom.current = true;
  };
  return { lineRef, markAtBottom, show, onScroll, attachScroll, followNewThreadToBottom, jump };
}

export function InboxView() {
  const objectives = objectiveStore.use();
  const { threads, rows, keep, resolved, paused, done } = useInboxRows();
  useSeen();
  const seenAt = useSeenAt();
  const asks = rows.filter(r => r.t.asks);
  const replied = rows.filter(r => unseenDeep(r.t, threads) > 0);
  const firstNew = rows.findIndex(r => r.first.from !== "isaac" && r.first.at > seenAt);
  const { lineRef, markAtBottom, show, onScroll, attachScroll, followNewThreadToBottom, jump } = useInboxScroll();
  const actions = useRowActions(threads, keep);
  const runs = dayRuns(rows);
  const days = new Set(rows.map(dayOfRow).filter(d => d !== NOT_WRITTEN_YET)).values().toArray().toReversed();
  const [step, setStep] = useState(0);
  const nextReplied = () => {
    const r = replied[step % replied.length];
    if (!r) return;
    show(r.t.id);
    setStep(s => s + 1);
  };

  return (
    <div ref={openInboxUntilItGoes} className="flex h-full flex-col">
      <InboxHeader replied={replied.length} onNextReplied={nextReplied} resolved={resolved} paused={paused} />
      <NeedsYouStrip asks={asks} onShow={show} />
      <DoneConfirm done={done} onOpen={openThread} />
      <section className="flex min-h-0 flex-1 flex-col">
        <div ref={attachScroll} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-5 pt-0 pb-4">
          {runs.map(run => (
            <DayRunSection key={run.day} run={run} rows={rows} firstNew={firstNew} days={days} jump={jump} lineRef={lineRef} objectives={objectives} actions={actions} />
          ))}
          <div key={rows.length} ref={followNewThreadToBottom} />
        </div>
        <Composer
          autoFocus
          agent="inbox-input"
          draftKey="inbox"
          placeholder="Message Threads"
          onSend={async text => {
            markAtBottom();
            await startThread(text);
          }}
          className="px-4 pt-1 pb-3"
        />
      </section>
    </div>
  );
}
