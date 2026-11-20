import { useCallback, useContext, useRef, useState } from "react";
import { useLatest } from "@/lib/effects";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { hasText } from "@/lib/utils";
import type { Thread } from "@/mock";
import { agentStore, movedStore, postToThread, threadStore } from "@/store";
import { Composer } from "./Composer";
import { flashMessage, takeCompose, useLayerScroll } from "./jump";
import { MovedChip } from "./Moved";
import { paneStore } from "./pane";
import { openPause } from "./Pause";
import { raise } from "./Raise";
import { markSeen, setSeen, firstUnseen } from "./seen";
import { ShotScope, shotsOf } from "./Viewer";
import { ThreadPanel } from "./ThreadPanel";
import { keyOf, messageActions, messageMenuFor, rootOf, type Message, type MessageActions } from "./page/actions";
import { JumpToNew } from "./page/JumpToNew";
import { EarlierInTheConversationLine, NudgeToggle } from "./page/marks";
import { ReplyRow, RootMessage } from "./page/messages";
import { resolveOrReopen, ThreadNavContext, type ThreadNav } from "./page/nav";
import { AsleepLines, isPendingOnASleeper } from "./page/AsleepLines";
import { Pending } from "./page/Pending";
import { QuoteSelectionButton, useQuotableSelection } from "./page/selection";
import { ThreadHeader } from "./page/ThreadHeader";
import { repliesOf } from "./Replies";

export { Pending } from "./page/Pending";
export { resolveOrReopen, ThreadNavContext, threadUp, type ThreadNav } from "./page/nav";

function useNewLine(thread: Thread) {
  const [line, setLine] = useState<{ id: string; at?: number | undefined; isMarkedUnread?: boolean }>();
  if (line?.id !== thread.id) setLine({ id: thread.id, at: firstUnseen(thread) });
  const lineAt = line?.id === thread.id ? line.at : undefined;
  return { lineAt, isMarkedUnread: line?.isMarkedUnread === true, setLine };
}

function useDetailColumn(isEmbedded: boolean) {
  const pane = paneStore.use();
  const isPaneOpen = !isEmbedded && hasText(pane);
  const [isDetailWithPane, setDetailWithPane] = useState(false);
  if (!isPaneOpen && isDetailWithPane) setDetailWithPane(false);
  return { isPaneOpen, isDetailShown: !isPaneOpen || isDetailWithPane, setDetailWithPane };
}

function landOnArrival(el: HTMLElement, isRestored: boolean, newLine: HTMLElement | null, focusComposer: () => void) {
  const landed = flashMessage();
  if (landed === undefined && !isRestored) {
    if (newLine) newLine.scrollIntoView({ block: "center" });
    else el.scrollTop = el.scrollHeight;
  }
  if (takeCompose() === true) focusComposer();
}

const NEAR_BOTTOM_PX = 80;

function useBottomWatch(thread: Thread) {
  const bottom = useRef({ id: thread.id, isAtBottom: true });
  const latest = useLatest(thread.id);
  const watch = useCallback(
    (sentinel: HTMLElement | null) => {
      if (!sentinel) return;
      const observer = new IntersectionObserver(
        ([entry]) => {
          bottom.current = { id: latest.current, isAtBottom: entry?.isIntersecting === true };
        },
        { root: sentinel.parentElement, rootMargin: `0px 0px ${NEAR_BOTTOM_PX}px 0px` },
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    },
    [latest],
  );
  return { bottom, watch };
}

type Arrivals = { bottom: React.RefObject<{ id: string; isAtBottom: boolean }>; hasNewLine: boolean; holdNewLine: (at: number | undefined) => void };

function useFollowArrivals(thread: Thread, scrollRef: React.RefObject<HTMLDivElement | null>, { bottom, hasNewLine, holdNewLine }: Arrivals) {
  const threadId = thread.id;
  const count = thread.messages.length;
  const isOwnLast = thread.messages.at(-1)?.from === "isaac";
  const unseenFrom = firstUnseen(thread);
  const latestHold = useLatest(holdNewLine);
  const latestHasNewLine = useLatest(hasNewLine);
  const followed = useRef<string>(undefined);
  return useCallback(
    (end: HTMLElement | null) => {
      if (!end) return;
      const isArrival = followed.current === threadId;
      followed.current = threadId;
      const isScrolledUp = bottom.current.id === threadId && !bottom.current.isAtBottom;
      if (isArrival && isScrolledUp && !isOwnLast) {
        latestHold.current(unseenFrom);
        return;
      }
      if (isArrival && !latestHasNewLine.current) markSeen(threadId, count);
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    },
    [threadId, count, isOwnLast, unseenFrom, scrollRef, bottom, latestHold, latestHasNewLine],
  );
}

function composerPlaceholder(thread: Thread, isEmbedded: boolean) {
  if (hasText(thread.parentId)) return "Reply in thread";
  return isEmbedded ? "Reply to thread…" : "Reply…";
}

function ThreadComposer({ thread, isEmbedded, onSent }: { thread: Thread; isEmbedded: boolean; onSent: () => void }) {
  const [nudge, setNudge] = usePersistentDraft(`thread:${thread.id}:nudge`);
  const send = (text: string) => {
    onSent();
    if (nudge === "") postToThread(thread.id, "isaac", text);
    else postToThread(thread.id, "isaac", text, "subthread");
  };
  return (
    <Composer
      agent="thread-input"
      draftKey={`thread:${thread.id}`}
      onRaise={text => {
        void raise(text);
      }}
      onSend={send}
      tools={<NudgeToggle on={nudge} set={isOn => setNudge(isOn ? "subthread" : "")} />}
      toolsOn={nudge !== ""}
      placeholder={composerPlaceholder(thread, isEmbedded)}
      className="px-4 pt-1 pb-3"
    />
  );
}

type MessagesProps = {
  thread: Thread;
  all: Thread[];
  root: Message | undefined;
  replies: Message[];
  firstNew: number;
  lineRef: React.RefObject<HTMLDivElement | null>;
  actions: MessageActions;
  messageMenu: ReturnType<typeof messageMenuFor>;
  nav: ThreadNav;
  selected: ReturnType<typeof useQuotableSelection>;
  onResolve: () => void;
  onPause: () => void;
};

function ThreadMessages({ thread, all, root, replies, firstNew, lineRef, actions, messageMenu, nav, selected, onResolve, onPause }: MessagesProps) {
  const agents = agentStore.use();
  return (
    <>
      {root?.ext?.context === true && <EarlierInTheConversationLine />}
      {root && <RootMessage thread={thread} all={all} root={root} actions={actions} messageMenu={messageMenu} onResolve={onResolve} onPause={onPause} />}
      {selected && <QuoteSelectionButton selected={selected} draftKey={`thread:${thread.id}`} />}
      {root && replies.length > 0 && !root.ext && (
        <p className="my-2 flex items-center gap-2 text-xs text-muted-foreground">
          {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
          <span className="h-px flex-1 bg-border" />
        </p>
      )}
      {replies.map((_, i) => (
        <ReplyRow key={i} thread={thread} all={all} root={root} replies={replies} i={i} isNew={i === firstNew} lineRef={lineRef} actions={actions} messageMenu={messageMenu} nav={nav} />
      ))}
      {thread.pending && !isPendingOnASleeper(thread) && <Pending pending={thread.pending} names={thread.pending.routerIds.map(rid => agents.find(a => a.id === rid)?.name ?? rid)} />}
      <AsleepLines thread={thread} />
    </>
  );
}

function useThreadMessages(thread: Thread, all: Thread[], nav: ThreadNav, focusComposer: () => void) {
  const { lineAt, isMarkedUnread, setLine } = useNewLine(thread);
  const root = rootOf(thread, all);
  const replies = repliesOf(thread);
  const actions = messageActions({ thread, all, root, replies, nav, focusComposer });
  const messageMenu = messageMenuFor(thread, actions, at => {
    setSeen(thread.id, at);
    setLine({ id: thread.id, at, isMarkedUnread: true });
  });
  const firstNew = lineAt === undefined ? -1 : replies.findIndex(m => thread.messages.indexOf(m) >= lineAt);
  const newKeys = firstNew < 0 ? [] : replies.slice(firstNew).map((m, i) => keyOf(m, firstNew + i));
  const holdNewLine = (at: number | undefined) => {
    if (lineAt === undefined) setLine({ id: thread.id, at });
  };
  const markReadThrough = (key: string) => {
    const read = replies.find((m, i) => keyOf(m, i) === key);
    if (read && !isMarkedUnread) markSeen(thread.id, thread.messages.indexOf(read) + 1);
  };
  const newLine = { hasNewLine: lineAt !== undefined, holdNewLine, markReadThrough };
  return { root, replies, actions, messageMenu, firstNew, newKeys, newLine, clearNewLine: () => setLine({ id: thread.id }) };
}

type BodyProps = { thread: Thread; all: Thread[]; back: string; isEmbedded: boolean };

function ThreadBody({ thread, all, back, isEmbedded }: BodyProps) {
  const nav = useContext(ThreadNavContext);
  const climb = () => nav.up(thread.id, back);
  const onResolve = () => {
    void resolveOrReopen(thread, climb);
  };
  const onPause = () => openPause(thread.id, climb);
  const { isPaneOpen, isDetailShown, setDetailWithPane } = useDetailColumn(isEmbedded);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const focusComposer = () => (scrollRef.current?.closest("[data-region]") ?? document).querySelector<HTMLElement>('[data-agent="thread-input"]')?.focus();
  const attachScroll = useLayerScroll(`${isEmbedded ? "pane:" : ""}thread:${thread.id}`, scrollRef, (el, isRestored) => landOnArrival(el, isRestored, lineRef.current, focusComposer));
  const { bottom, watch: watchBottom } = useBottomWatch(thread);
  const { root, replies, actions, messageMenu, firstNew, newKeys, newLine, clearNewLine } = useThreadMessages(thread, all, nav, focusComposer);
  const followArrivals = useFollowArrivals(thread, scrollRef, { bottom, ...newLine });
  const selected = useQuotableSelection(scrollRef);
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {!isEmbedded && <ThreadHeader thread={thread} all={all} back={back} isPaneOpen={isPaneOpen} isDetailShown={isDetailShown} onDetailShown={setDetailWithPane} onResolve={onResolve} onPause={onPause} />}
      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ShotScope.Provider value={shotsOf([...(root ? [root] : []), ...replies])}>
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div ref={attachScroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <ThreadMessages thread={thread} all={all} root={root} replies={replies} firstNew={firstNew} lineRef={lineRef} actions={actions} messageMenu={messageMenu} nav={nav} selected={selected} onResolve={onResolve} onPause={onPause} />
                <div key={`${thread.messages.length}:${thread.pending !== undefined}`} ref={followArrivals} />
                <div ref={watchBottom} />
              </div>
              <JumpToNew threadId={thread.id} newKeys={newKeys} scrollRef={scrollRef} onSeenThrough={newLine.markReadThrough} />
            </div>
          </ShotScope.Provider>
          <ThreadComposer thread={thread} isEmbedded={isEmbedded} onSent={clearNewLine} />
        </section>
        {!isEmbedded && (
          <div data-agent="thread-detail" style={{ width: isDetailShown ? "18rem" : 0 }} className="shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none">
            <ThreadPanel thread={thread} />
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadPage({ id, back, embedded }: { id: string; back: string; embedded?: boolean }) {
  const all = threadStore.use();
  const thread = all.find(t => t.id === id);
  const moved = movedStore.use().find(t => t.id === id)?.movedTo;
  if (!thread && moved)
    return (
      <div className="flex flex-col gap-1 p-6 text-sm text-muted-foreground">
        This thread was merged into another, with its messages.
        <MovedChip to={moved} />
      </div>
    );
  if (!thread) return <p className="p-6 text-muted-foreground">No thread {id}.</p>;
  return <ThreadBody thread={thread} all={all} back={back} isEmbedded={embedded === true} />;
}
