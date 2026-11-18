import { AlarmClock, ArrowLeft, ArrowUpToLine, Check, ChevronRight, GitBranch, MessageSquareReply, MessagesSquare, PanelRight, Quote, RotateCcw } from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { AgentFace } from "@/components/AgentFace";
import { AgentLink } from "@/components/AgentLink";
import { Elapsed } from "@/components/Working";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { agentStore, openSubthread, postToThread, setResolved, threadStore } from "@/store";
import { Composer, quoteInto, quoted } from "./Composer";
import { composeOnArrival, flashMessage, goToMessage, takeCompose, useLayerScroll } from "./jump";
import { MessageRow, when } from "./MessageRow";
import { Replies, repliesOf } from "./Replies";
import { pinItem, RowMenu, messageItems, threadItems } from "./RowMenu";
import { firstUnseen, markSeen, setSeen } from "./seen";
import { Rich } from "./Rich";
import { ShotScope, shotsOf } from "./Viewer";
import { AgentStack, ThreadPanel } from "./ThreadPanel";
import { PinToggle } from "./PinToggle";
import { paneStore } from "./pane";
import { openRaise, raise, raisedTo } from "./Raise";
import { HoverBar } from "./HoverBar";
import { openPause, pausedLabel } from "./Pause";

/** Escape climbs one level: a subthread goes to its parent at the message it hangs off, a top thread to the view it came from. */
export function threadUp(id: string, view: string) {
  const t = threadStore.get().find(x => x.id === id);
  if (!t?.parentId) return void (location.hash = view);
  goToMessage(t.parentId, t.parentMessageId);
}

/**
 * Where a thread page goes when it opens another thread (a subthread, its parent) or climbs out. The page in the window moves the
 * address; the side pane keeps it all inside itself.
 */
export type ThreadNav = { open(threadId: string): void; up(threadId: string, view: string): void };
export const ThreadNavContext = createContext<ThreadNav>({ open: id => void (location.hash = `thread/${id}`), up: threadUp });

/** Resolving is done with a thread, so it climbs a level as Escape does once the server has it; reopening stays put. */
export async function resolveOrReopen(thread: Thread, up: () => void) {
  const resolving = !thread.resolved;
  await setResolved(thread.id, resolving);
  if (resolving) up();
}

// Text selected inside one message, with where to draw its Quote button.
type Selected = { thread: string; message: string; text: string; x: number; y: number };

// Slack's grouping: a sender's next message within this long drops its picture and name.
const GROUP_MS = 5 * 60_000;

// The router's acknowledgement while Isaac's last message waits on an answer, gone when it lands; drawn as BoardUI's thinking line:
// no pill, the router's face turning where a message's picture sits, then its status if it set one, else a shimmering "Thinking…",
// and how long it has been at it. Who it is lives in the tooltip. `inline` is the inbox's replies line: a small face, no column.
export function Pending({ pending, names, inline }: { pending: NonNullable<Thread["pending"]>; names: string[]; inline?: boolean }) {
  const who = `${names.length > 1 ? "routers" : "router"} ${names.join(", ")}`;
  const router = pending.routerIds[0] ?? "";
  const face = (expression: "working" | "error", still?: boolean) =>
    inline ? (
      <AgentLink id={router} className="flex shrink-0">
        <AgentFace id={router} expression={expression} still={still} small className="size-5" />
      </AgentLink>
    ) : (
      <span className="flex w-9 shrink-0 justify-center">
        <AgentLink id={router} className="flex">
          <AgentFace id={router} expression={expression} still={still} className="size-7" />
        </AgentLink>
      </span>
    );
  const row = cn("flex max-w-full min-w-0 items-center text-muted-foreground", inline ? "gap-1.5 text-xs" : "gap-2.5 py-1 text-sm");
  if (pending.stale)
    return (
      <p data-agent="thread-pending" title={`${who} stopped without answering (since ${when(pending.since)})`} className={row}>
        {face("error", true)}
        <span className="min-w-0 truncate">Stopped without answering</span>
      </p>
    );
  return (
    <p data-agent="thread-pending" title={`${who}: ${pending.status ?? "working on a response"} (since ${when(pending.since)})`} className={row}>
      {face("working")}
      {/* A router's status is markdown with chips; it may sit inside the inbox row's link, so its chips stay text. */}
      {pending.status ? (
        <span className="min-w-0 truncate">
          <Rich still text={pending.status} />
        </span>
      ) : (
        <span className="shimmer-soft min-w-0 truncate">Thinking…</span>
      )}
      <Elapsed since={pending.since} className="text-[0.85em] opacity-80" />
    </p>
  );
}

/** `embedded` is the side pane's: no header (the pane draws its own) and no info column. */
export function ThreadPage({ id, back, embedded }: { id: string; back: string; embedded?: boolean }) {
  const nav = useContext(ThreadNavContext);
  const climb = () => nav.up(id, back);
  const paneOpen = !embedded && !!paneStore.use();
  const [detailWithPane, setDetailWithPane] = useState(false);
  const detail = !paneOpen || detailWithPane;
  useEffect(() => void (paneOpen || setDetailWithPane(false)), [paneOpen]);
  const all = threadStore.use();
  const thread = all.find(t => t.id === id);
  const agents = agentStore.use();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Slack's red "New" line: above the first message he hadn't seen when he opened the thread, taken before it is marked seen,
  // so it stays put while he reads and as more arrive under it. Gone once he writes here or leaves; "Mark unread from here" moves it.
  const [line, setLine] = useState<{ id: string; at?: number }>();
  if (thread && line?.id !== id) setLine({ id, at: firstUnseen(thread) });
  const lineAt = line?.id === id ? line.at : undefined;
  const lineRef = useRef<HTMLDivElement>(null);
  const opened = useRef<string>(undefined);

  // Back up from a subthread (or by Back/Forward) it is where he left it; opening with something unread scrolls to the line;
  // otherwise, and as messages arrive, to the bottom.
  const restored = useLayerScroll(`${embedded ? "pane:" : ""}thread:${id}`, scrollRef);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !thread) return;
    const opening = opened.current !== id;
    if (opening && lineRef.current && !restored.current) lineRef.current.scrollIntoView({ block: "center" });
    else if (!opening || !restored.current) el.scrollTop = el.scrollHeight;
    opened.current = id;
  }, [id, !!thread, thread?.messages.length, !!thread?.pending]);

  useEffect(() => {
    if (thread) markSeen(thread.id, thread.messages.length);
  }, [thread?.id, thread?.messages.length]);

  const composer = () => (scrollRef.current?.closest("[data-region]") ?? document).querySelector<HTMLElement>('[data-agent="thread-input"]')?.focus();
  // The root, then the replies: each keyed by its id, or its place for an old message without one.
  const root = thread?.parentId ? all.find(t => t.id === thread.parentId)?.messages.find(m => m.id === thread.parentMessageId) : thread?.messages[0];
  const replies = thread ? repliesOf(thread) : [];
  // Whether his next message here asks for its answer in a subthread; each thread remembers it, as it does a draft.
  const [nudge, setNudge] = usePersistentDraft(`thread:${id}:nudge`);
  const keyOf = (m: { id?: string }, i: number) => m.id ?? `#${i}`;
  const byKey = (k: string) => (root && k === keyOf(root, -1) ? root : replies.find((m, i) => keyOf(m, i) === k));
  // What a message's menus and hover bar do to it, by its key.
  const actions = {
    open: (k: string) => {
      const sub = all.find(t => t.parentId === id && t.parentMessageId === k);
      if (sub && (sub.messages.length > 0 || sub.pending)) nav.open(sub.id);
    },
    // Replying to the root is replying here; any other message gets a subthread of its own.
    reply: (k: string) => (k === root?.id || !byKey(k)?.id ? composer() : (composeOnArrival(), void openSubthread(id, k, nav.open))),
    raise: (k: string) => {
      const m = byKey(k);
      if (m?.id) openRaise(m === root ? (thread?.parentId ?? id) : id, m.id, m.text);
    },
    quote: (k: string) => {
      const m = byKey(k);
      if (m?.id) quoteInto(`thread:${id}`, quoted(m.text, m === root ? (thread?.parentId ?? id) : id, m.id));
    },
  };
  const firstNew = lineAt === undefined ? -1 : replies.findIndex(m => thread!.messages.indexOf(m) >= lineAt);

  // Landing on a message (from its subthread, or a quote's link) flashes it; "Reply in thread" from a menu opens in the box.
  useEffect(() => {
    // With nothing to land on, the "New" line is brought into view, unless the page's scroll was put back as he left it.
    const landed = flashMessage();
    if (!landed && !restored.current) lineRef.current?.scrollIntoView({ block: "center" });
    if (takeCompose()) composer();
  }, [id]);

  // A selection inside one message offers to quote it; anything else hides the button.
  const [selected, setSelected] = useState<Selected>();
  useEffect(() => {
    const onChange = () => {
      const sel = getSelection();
      const text = sel?.toString().trim();
      const at = (n: Node | null | undefined) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>("[data-msg]");
      const msg = sel && at(sel.anchorNode);
      if (!text || !msg || msg !== at(sel.focusNode) || !scrollRef.current?.contains(msg)) return setSelected(undefined);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setSelected({ thread: msg.dataset.thread!, message: msg.dataset.msg!, text, x: r.right, y: r.top });
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  if (!thread) return <p className="p-6 text-muted-foreground">No thread {id}.</p>;

  // A subthread's root is a message in its parent; the breadcrumb climbs back up through every ancestor.
  const ancestors: Thread[] = [];
  for (let up = all.find(t => t.id === thread.parentId); up; up = all.find(t => t.id === up!.parentId)) ancestors.unshift(up);
  const subOf = (messageId?: string) => all.find(t => t.parentId === thread.id && t.parentMessageId === messageId);
  // Right-click on a message offers what the keys do to it. Unread from the root would be unread from nothing: it's on the inbox row.
  const messageMenu = (m: Thread["messages"][number], k: string) => {
    const sub = subOf(m.id);
    const at = thread.messages.indexOf(m);
    return messageItems(m.text, {
      open: sub && (sub.messages.length > 0 || sub.pending) ? () => actions.open(k) : undefined,
      reply: m.id ? () => actions.reply(k) : undefined,
      quote: m.id ? () => actions.quote(k) : undefined,
      raise: m.id ? () => actions.raise(k) : undefined,
      unread: at >= (thread.parentId ? 0 : 1) ? () => (setSeen(thread.id, at), setLine({ id, at })) : undefined,
      link: m.id && `[[msg:${m === root ? (thread.parentId ?? id) : id}/${m.id}]]`,
    });
  };


  return (
    <div className="flex h-full flex-col overflow-hidden">
      {!embedded && (
      <RowMenu agent="thread-header" items={threadItems(thread, all, { resolve: () => resolveOrReopen(thread, climb), pause: () => openPause(thread.id, climb) })}>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button variant="ghost" size="icon" asChild data-agent="back">
          <a href={thread.parentId ? `#thread/${thread.parentId}` : `#${back}`}>
            <ArrowLeft />
          </a>
        </Button>
        <MessagesSquare className="size-4 text-muted-foreground" />
        {ancestors.map(a => (
          <Fragment key={a.id}>
            <a href={`#thread/${a.id}`} data-agent={`thread-up:${a.id}`} className="max-w-56 truncate text-sm text-muted-foreground hover:text-foreground">
              {a.title}
            </a>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          </Fragment>
        ))}
        <h1 className={cn("truncate text-xl font-semibold tracking-tight", thread.resolved && "text-muted-foreground")}>{thread.title}</h1>
        {thread.resolved && <span className="text-xs text-muted-foreground">resolved {when(thread.resolved.at)}</span>}
        {thread.paused && <span data-agent="thread-paused" title={`paused ${pausedLabel(thread.paused)}`} className="min-w-0 truncate text-xs whitespace-nowrap text-muted-foreground">paused {pausedLabel(thread.paused)}</span>}
        <span className="ml-auto" />
        <AgentStack thread={thread} onOpen={() => (setDetailWithPane(true), requestAnimationFrame(() => document.getElementById(`agents-${thread.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })))} />
        {paneOpen && (
          <button data-agent="thread-detail-toggle" aria-pressed={detail} title={detail ? "Hide details" : "Show details"} onClick={() => setDetailWithPane(!detail)} className={cn("flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors", detail ? "border-link/30 bg-link/10 text-link" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground")}>
            <PanelRight className="size-4" />
          </button>
        )}
        <PinToggle thread={thread} />
        {!thread.parentId && (
          <Button variant="outline" size="sm" data-agent="thread-pause" title="Pause until a time" onClick={() => openPause(thread.id, climb)}>
            <AlarmClock />
            {thread.paused ? "Paused" : "Pause"}
          </Button>
        )}
        <Button variant="outline" size="sm" data-agent="thread-resolve" onClick={() => resolveOrReopen(thread, climb)}>
          {thread.resolved ? <RotateCcw /> : <Check />}
          {thread.resolved ? "Reopen" : "Resolve"}
        </Button>
      </header>
      </RowMenu>
      )}

      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* An image here opens the viewer over this thread's images, the root's included and its subthreads' not. */}
          <ShotScope.Provider value={shotsOf([...(root ? [root] : []), ...replies])}>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {root?.ext?.context && <EarlierLine />}
            {root && (
              <RowMenu agent={`msg:${keyOf(root, -1)}`} items={messageMenu(root, keyOf(root, -1))}>
              <div data-msg={root.id} data-thread={thread.parentId ?? thread.id} data-row={keyOf(root, -1)} className="group/bar relative">
                <MessageRow from={root.from} at={root.at} text={root.text} ext={root.ext}>
                  {root.nudge && <NudgeMark />}
                  {root.wake && <WakeMark />}
                  {root.id && <RaisedMark threads={all} thread={thread.parentId ?? thread.id} message={root.id} />}
                </MessageRow>
                {/* The root stands for the thread: resolving or pausing it here is the thread's, as the header's buttons are. */}
                <HoverBar
                  agent={`msg:${keyOf(root, -1)}`}
                  actions={[
                    { label: thread.resolved ? "Reopen" : "Resolve", icon: thread.resolved ? RotateCcw : Check, run: () => resolveOrReopen(thread, climb), agent: `msg-resolve:${thread.id}` },
                    !thread.parentId && { label: thread.paused ? "Pause again…" : "Pause…", icon: AlarmClock, run: () => openPause(thread.id, climb), agent: `msg-pause:${thread.id}` },
                    { label: "Reply", icon: MessageSquareReply, run: () => actions.reply(keyOf(root, -1)) },
                    !!root.id && { label: "Quote", icon: Quote, run: () => actions.quote(keyOf(root, -1)), agent: `quote:${root.id}` },
                    !!root.id && { label: "Raise to Threads", icon: ArrowUpToLine, run: () => actions.raise(keyOf(root, -1)), agent: `raise:${root.id}` },
                    pinItem(thread),
                  ]}
                  menu={messageMenu(root, keyOf(root, -1))}
                />
              </div>
              </RowMenu>
            )}
            {selected && (
              <button
                data-agent="quote-selection"
                onMouseDown={e => e.preventDefault()}
                onClick={() => (quoteInto(`thread:${thread.id}`, quoted(selected.text, selected.thread, selected.message)), getSelection()?.removeAllRanges())}
                style={{ left: selected.x, top: selected.y - 30 }}
                className="fixed z-20 flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs shadow-raised hover:border-ring"
              >
                <Quote className="size-3" />
                Quote
              </button>
            )}
            {root && replies.length > 0 && !root.ext && (
              <p className="my-2 flex items-center gap-2 text-xs text-muted-foreground">
                {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
                <span className="h-px flex-1 bg-border" />
              </p>
            )}
            {replies.map((m, i) => {
              // Context the feed already showed earlier in this thread isn't shown again.
              if (m.ext?.context && thread.messages.slice(0, thread.messages.indexOf(m)).some(x => x.ext?.link === m.ext!.link && x.text === m.text)) return null;
              const prev = replies[i - 1];
              const sub = subOf(m.id);
              // What agents posted after he resolved it sits below a line saying so; where the "New" line falls too, that line says both.
              const resolvedHere = thread.resolved && m.at > thread.resolved.at && !(prev && prev.at > thread.resolved.at);
              const isNew = i === firstNew;
              const grouped = !isNew && !m.wake && prev?.from === m.from && prev.ext?.name === m.ext?.name && !!prev.ext?.context === !!m.ext?.context && Date.parse(m.at) - Date.parse(prev.at) <= GROUP_MS;
              const earlier = m.ext?.context && !(prev ?? root)?.ext?.context;
              return (
                <Fragment key={i}>
                {resolvedHere && !isNew && <p className="my-2 border-t pt-1 text-center text-xs text-muted-foreground">new since resolved</p>}
                {earlier && <EarlierLine />}
                {isNew && (
                  <div ref={lineRef} data-agent="unread-line" className="my-2 flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
                    <span className="h-px flex-1 bg-destructive" />
                    {resolvedHere ? "New since resolved" : "New"}
                  </div>
                )}
                <RowMenu agent={`msg:${keyOf(m, i)}`} items={messageMenu(m, keyOf(m, i))}>
                <div data-msg={m.id} data-thread={thread.id} data-row={keyOf(m, i)} className="group/bar relative">
                  <MessageRow from={m.from} at={m.at} text={m.text} ext={m.ext} where={!!m.ext && conversationOf(m.ext.link) !== conversationOf((replies.slice(0, i).findLast(x => x.ext) ?? root)?.ext?.link)} grouped={grouped} className={cn(!grouped && i > 0 && "mt-2.5")}>
                    {m.nudge && <NudgeMark />}
                    {m.wake && <WakeMark />}
                    {m.id && <RaisedMark threads={all} thread={thread.id} message={m.id} />}
                    {sub && (sub.messages.length > 0 || sub.pending) && <Replies t={sub} />}
                  </MessageRow>
                  <HoverBar
                    agent={`msg:${keyOf(m, i)}`}
                    actions={[
                      !!m.id && { label: "Reply in thread", icon: MessageSquareReply, run: () => void openSubthread(thread.id, m.id!, nav.open), agent: `reply-in-thread:${m.id}` },
                      !!m.id && { label: "Quote", icon: Quote, run: () => quoteInto(`thread:${thread.id}`, quoted(m.text, thread.id, m.id!)), agent: `quote:${m.id}` },
                      !!m.id && { label: "Raise to Threads", icon: ArrowUpToLine, run: () => actions.raise(keyOf(m, i)), agent: `raise:${m.id}` },
                    ]}
                    menu={messageMenu(m, keyOf(m, i))}
                  />
                </div>
                </RowMenu>
                </Fragment>
              );
            })}
            {thread.pending && <Pending pending={thread.pending} names={thread.pending.routerIds.map(rid => agents.find(a => a.id === rid)?.name ?? rid)} />}
          </div>
          </ShotScope.Provider>
          <Composer agent="thread-input" draftKey={`thread:${thread.id}`} onRaise={text => void raise(text)} onSend={text => (setLine({ id }), postToThread(thread.id, "isaac", text, nudge ? "subthread" : undefined))} tools={<NudgeToggle on={nudge} set={on => setNudge(on ? "subthread" : "")} />} toolsOn={!!nudge} placeholder={thread.parentId ? "Reply in thread" : embedded ? "Reply to thread…" : "Reply…"} className="px-4 pt-1 pb-3" />
        </section>

        {/* With a thread open in the side pane, the details fold away so the messages and the pane share the width; they come back
            when the pane closes, or from the header's toggle for as long as he stays on this page. */}
        {!embedded && (
          <div data-agent="thread-detail" style={{ width: detail ? "18rem" : 0 }} className="shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none">
            <ThreadPanel thread={thread} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Off by default: on, his message asks the router to answer it in a subthread of its own rather than inline. It never takes focus, so the box keeps it. */
function NudgeToggle({ on, set }: { on: string; set: (on: boolean) => void }) {
  return (
    <button
      type="button"
      data-agent="thread-nudge"
      aria-pressed={!!on}
      onMouseDown={e => e.preventDefault()}
      onClick={() => set(!on)}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
    >
      <GitBranch className={cn("size-3.5 shrink-0", on ? "text-link" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1">Ask for the answer in a subthread</span>
      {on && <Check className="size-3.5 shrink-0 text-link" />}
    </button>
  );
}

/** Under a message he raised to Threads: where it went, each a link to that thread. */
function RaisedMark({ threads, thread, message }: { threads: Thread[]; thread: string; message: string }) {
  const to = raisedTo(threads, thread, message);
  return to.map(t => (
    <a key={t.id} href={`#thread/${t.id}`} data-agent={`raised:${t.id}`} title={t.title} className="mt-0.5 flex w-fit max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowUpToLine className="size-3 shrink-0" />
      <span className="truncate">raised to {t.title}</span>
    </a>
  ));
}

/** On his sent message: he asked for its answer in a subthread. */
const NudgeMark = () => (
  <span title="asked for the answer in a subthread" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
    <GitBranch className="size-2.5" />
    subthread asked
  </span>
);

/** On his message a pause's end sent: he wrote it when he paused the thread. */
const WakeMark = () => (
  <span data-agent="wake-mark" title="written when he paused the thread, sent as it woke" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
    ⏰ sent on wake
  </span>
);

/** Above the messages from before the new ones in a Slack or GitHub conversation the feed brought in. */
function EarlierLine() {
  return (
    <p className="my-2 flex items-center gap-2 text-[11px] text-muted-foreground">
      earlier in this conversation
      <span className="h-px flex-1 bg-border" />
    </p>
  );
}

// A Slack link's channel, or a GitHub link's PR: the chip naming where a message was said shows when it changes.
const conversationOf = (link?: string) => link?.match(/archives\/(\w+)|github\.com\/([\w.-]+\/[\w.-]+\/\w+\/\d+)/)?.slice(1).find(Boolean);
