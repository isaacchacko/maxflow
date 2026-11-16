import { ArrowLeft, Check, ChevronRight, ExternalLink, GitBranch, MessageSquareReply, MessagesSquare, Network, Quote, RotateCcw, Waypoints } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { Working } from "@/components/Working";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { agentStore, answerHere, objectiveStore, openSubthread, postToThread, setResolved, threadStore } from "@/store";
import { Composer, quoteInto } from "./Composer";
import { composeOnArrival, flashMessage, goToMessage, takeCompose } from "./jump";
import { MessageRow, when } from "./MessageRow";
import { Replies, repliesOf } from "./Replies";
import { RowMenu, messageItems, threadItems } from "./RowMenu";
import { firstUnseen, markSeen, setSeen } from "./seen";
import { RefChip, Rich, refsIn, urlsIn, type Ref } from "./Rich";
import { KindMenu } from "./KindMenu";
import { ShotScope, shotsOf } from "./Viewer";
import { useVim, vimRow, type VimActions } from "./vim";

/** Escape climbs one level: a subthread goes to its parent at the message it hangs off, a top thread to the view it came from. */
export function threadUp(id: string, view: string) {
  const t = threadStore.get().find(x => x.id === id);
  if (!t?.parentId) return void (location.hash = view);
  goToMessage(t.parentId, t.parentMessageId);
}

/** Resolving is done with a thread, so it climbs a level as Escape does once the server has it; reopening stays put. */
async function resolveOrReopen(thread: Thread, view: string) {
  const resolving = !thread.resolved;
  await setResolved(thread.id, resolving);
  if (resolving) threadUp(thread.id, view);
}

// Text selected inside one message, with where to draw its Quote button.
type Selected = { thread: string; message: string; text: string; x: number; y: number };

/** A quote as markdown: the passage, then a link back to the message it came from, which draws as a chip. */
const quoted = (text: string, thread: string, message: string) => `${text.trim().split("\n").map(l => `> ${l}`).join("\n")}\n>\n> — [[msg:${thread}/${message}]]`;

// Slack's grouping: a sender's next message within this long drops its picture and name.
const GROUP_MS = 5 * 60_000;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

// The router's acknowledgement: one line while Isaac's last message waits on an answer, gone when it lands.
export function Pending({ pending, names }: { pending: NonNullable<Thread["pending"]>; names: string[] }) {
  const who = `${names.length > 1 ? "routers" : "router"} ${names.join(", ")}`;
  if (pending.stale)
    return (
      <p data-agent="thread-pending" className="text-xs text-muted-foreground">
        {who} stopped without answering · since {when(pending.since)}
      </p>
    );
  return (
    <p data-agent="thread-pending" className="working-pill flex w-fit max-w-full min-w-0 items-center gap-2 py-1 pr-3 pl-1.5 text-xs font-medium">
      <Working />
      {/* A router's status is markdown with chips; it may sit inside the inbox row's link, so its chips stay text. */}
      <span className="shimmer min-w-0 truncate">{pending.status ? <Rich still text={`${names[0]}: ${pending.status}…`} /> : `${who} ${names.length > 1 ? "are" : "is"} working on a response…`}</span>
      <span className="text-muted-foreground tabular-nums">since {when(pending.since)}</span>
    </p>
  );
}

/**
 * A command he gave, under his message: its router's result on one line (open, in full), or that it is still running, with a
 * way to have the message talked through instead.
 */
function CommandStatus({ threadId, messageId, result }: { threadId: string; messageId?: string; result?: Thread["messages"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-agent={`command-status:${messageId}`} className="mt-1 ml-11.5 flex flex-col gap-1">
      <p className="flex min-w-0 items-center gap-2 text-xs">
        {result ? <Check className="size-3 shrink-0 text-ok" /> : <Working className="size-3" />}
        <button onClick={() => result && setOpen(v => !v)} className={cn("min-w-0 truncate text-left text-muted-foreground", result && "hover:text-foreground")}>
          {result ? (
            <>
              ran as a command · <Rich still text={result.text.split("\n")[0]} />
            </>
          ) : (
            "running as a command…"
          )}
        </button>
        {result && messageId && (
          <button data-agent={`answer-here:${messageId}`} onClick={() => answerHere(threadId, messageId)} className="shrink-0 rounded-full border bg-card px-2 text-muted-foreground hover:border-ring hover:text-foreground">
            ↗ answer here instead
          </button>
        )}
      </p>
      {open && result && <MessageRow from={result.from} at={result.at} text={result.text} />}
    </div>
  );
}

export function ThreadPage({ id, back }: { id: string; back: string }) {
  const all = threadStore.use();
  const thread = all.find(t => t.id === id);
  const agents = agentStore.use();
  const objective = objectiveStore.use().find(o => o.id === thread?.objectiveId);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Slack's red "New" line: above the first message he hadn't seen when he opened the thread, taken before it is marked seen,
  // so it stays put while he reads and as more arrive under it. Gone once he writes here or leaves; "Mark unread from here" moves it.
  const [line, setLine] = useState<{ id: string; at?: number }>();
  if (thread && line?.id !== id) setLine({ id, at: firstUnseen(thread) });
  const lineAt = line?.id === id ? line.at : undefined;
  const lineRef = useRef<HTMLDivElement>(null);
  const opened = useRef<string>(undefined);

  // Opening with something unread scrolls to the line; otherwise, and as messages arrive, to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !thread) return;
    if (opened.current !== id && lineRef.current) lineRef.current.scrollIntoView({ block: "center" });
    else el.scrollTop = el.scrollHeight;
    opened.current = id;
  }, [id, !!thread, thread?.messages.length, !!thread?.pending]);

  useEffect(() => {
    if (thread) markSeen(thread.id, thread.messages.length);
  }, [thread?.id, thread?.messages.length]);

  const composer = () => document.querySelector<HTMLElement>('[data-agent="thread-input"]')?.focus();
  // The keyboard cursor walks the root, then the replies: each by its id, or its place for an old message without one.
  const root = thread?.parentId ? all.find(t => t.id === thread.parentId)?.messages.find(m => m.id === thread.parentMessageId) : thread?.messages[0];
  // A router's command result draws under the message it answers, not as a reply of its own.
  const replies = thread ? repliesOf(thread).filter(m => !m.re) : [];
  // Whether his next message here asks for its answer in a subthread; each thread remembers it, as it does a draft.
  const [nudge, setNudge] = usePersistentDraft(`thread:${id}:nudge`);
  const resultFor = (m?: { id?: string }) => (m?.id ? thread?.messages.findLast(x => x.re === m.id) : undefined);
  // In a command thread his last message runs until its router posts the result.
  const lastMine = thread?.messages.findLast(m => m.from === "isaac");
  const running = thread?.kind === "command" && !thread.done && !resultFor(lastMine) ? lastMine : undefined;
  const keyOf = (m: { id?: string }, i: number) => m.id ?? `#${i}`;
  const keys = [...(root ? [keyOf(root, -1)] : []), ...replies.map(keyOf)];
  const byKey = (k: string) => (root && k === keyOf(root, -1) ? root : replies.find((m, i) => keyOf(m, i) === k));
  const actions = {
    compose: composer,
    up: () => threadUp(id, back),
    resolve: () => thread && resolveOrReopen(thread, back),
    open: k => {
      const sub = all.find(t => t.parentId === id && t.parentMessageId === k);
      if (sub && (sub.messages.length > 0 || sub.pending)) location.hash = `thread/${sub.id}`;
    },
    // Replying to the root is replying here; any other message gets a subthread of its own.
    reply: k => (k === root?.id || !byKey(k)?.id ? composer() : (composeOnArrival(), void openSubthread(id, k))),
    quote: k => {
      const m = byKey(k);
      if (m?.id) quoteInto(`thread:${id}`, quoted(m.text, m === root ? (thread?.parentId ?? id) : id, m.id));
    },
  } satisfies VimActions;
  const vim = useVim(`thread:${id}`, keys, scrollRef, "last", actions);
  const firstNew = lineAt === undefined ? -1 : replies.findIndex(m => thread!.messages.indexOf(m) >= lineAt);

  // Landing on a message (from its subthread, or a quote's link) puts the cursor there; replying from the keyboard opens in the box.
  useEffect(() => {
    // With nothing to land on, the cursor starts at the first unread, and the line is scrolled to after vim restores its cursor.
    const landed = flashMessage();
    if (!landed) lineRef.current?.scrollIntoView({ block: "center" });
    vim.move(landed ?? (firstNew >= 0 ? keyOf(replies[firstNew]!, firstNew) : undefined), false);
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
      unread: at >= (thread.parentId ? 0 : 1) ? () => (setSeen(thread.id, at), setLine({ id, at })) : undefined,
      link: m.id && `[[msg:${m === root ? (thread.parentId ?? id) : id}/${m.id}]]`,
    });
  };

  const mentioned = new Map<string, Ref>();
  for (const m of thread.messages) for (const r of refsIn(m.text)) mentioned.set(`${r.kind}:${r.id}`, r);
  const links = new Map(thread.messages.flatMap(m => urlsIn(m.text)).map(l => [l.url, l]));

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <RowMenu agent="thread-header" items={threadItems(thread, all, { resolve: () => resolveOrReopen(thread, back) })}>
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild data-agent="back">
          <a href={thread.parentId ? `#thread/${thread.parentId}` : `#${back}`}>
            <ArrowLeft />
          </a>
        </Button>
        {/* A top thread's glyph is its kind, and picks it; a subthread's is just a thread's. */}
        {thread.parentId ? <MessagesSquare className="size-4 text-muted-foreground" /> : <KindMenu thread={thread} />}
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
        <Button variant="outline" size="sm" className="ml-auto" data-agent="thread-resolve" onClick={() => resolveOrReopen(thread, back)}>
          {thread.resolved ? <RotateCcw /> : <Check />}
          {thread.resolved ? "Reopen" : "Resolve"}
        </Button>
      </header>
      </RowMenu>

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-card shadow-card">
          {/* An image here opens the viewer over this thread's images, the root's included and its subthreads' not. */}
          <ShotScope.Provider value={shotsOf([...(root ? [root] : []), ...replies])}>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {root && (
              <RowMenu agent={`msg:${keyOf(root, -1)}`} items={messageMenu(root, keyOf(root, -1))}>
              <div data-msg={root.id} data-thread={thread.parentId ?? thread.id} {...vimRow(keyOf(root, -1))}>
                <MessageRow from={root.from} at={root.at} text={root.text} active={vim.cursor === keyOf(root, -1)}>
                  {root.nudge && <NudgeMark />}
                </MessageRow>
                {(resultFor(root) || running === root) && <CommandStatus threadId={thread.parentId ?? thread.id} messageId={root.id} result={resultFor(root)} />}
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
            {root && replies.length > 0 && (
              <p className="my-2 flex items-center gap-2 text-xs text-muted-foreground">
                {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
                <span className="h-px flex-1 bg-border" />
              </p>
            )}
            {replies.map((m, i) => {
              const prev = replies[i - 1];
              const sub = subOf(m.id);
              // What agents posted after he resolved it sits below a line saying so; where the "New" line falls too, that line says both.
              const resolvedHere = thread.resolved && m.at > thread.resolved.at && !(prev && prev.at > thread.resolved.at);
              const isNew = i === firstNew;
              const grouped = !isNew && prev?.from === m.from && Date.parse(m.at) - Date.parse(prev.at) <= GROUP_MS;
              return (
                <Fragment key={i}>
                {resolvedHere && !isNew && <p className="my-2 border-t pt-1 text-center text-xs text-muted-foreground">new since resolved</p>}
                {isNew && (
                  <div ref={lineRef} data-agent="unread-line" className="my-2 flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
                    <span className="h-px flex-1 bg-destructive" />
                    {resolvedHere ? "New since resolved" : "New"}
                  </div>
                )}
                <RowMenu agent={`msg:${keyOf(m, i)}`} items={messageMenu(m, keyOf(m, i))}>
                <div data-msg={m.id} data-thread={thread.id} {...vimRow(keyOf(m, i))} className="group/msg relative">
                  <MessageRow from={m.from} at={m.at} text={m.text} grouped={grouped} active={vim.cursor === keyOf(m, i)} className={cn(!grouped && i > 0 && "mt-2.5")}>
                    {m.nudge && <NudgeMark />}
                    {sub && (sub.messages.length > 0 || sub.pending) && <Replies t={sub} />}
                  </MessageRow>
                  {(resultFor(m) || running === m) && <CommandStatus threadId={thread.id} messageId={m.id} result={resultFor(m)} />}
                  {m.id && (
                    <button
                      data-agent={`reply-in-thread:${m.id}`}
                      title="Reply in thread"
                      onClick={() => openSubthread(thread.id, m.id!)}
                      className="absolute top-0 right-0 rounded-md border bg-card p-1 text-muted-foreground shadow-card opacity-0 group-hover/msg:opacity-100 hover:text-foreground"
                    >
                      <MessageSquareReply className="size-3.5" />
                    </button>
                  )}
                  {m.id && (
                    <button
                      data-agent={`quote:${m.id}`}
                      title="Quote"
                      onClick={() => quoteInto(`thread:${thread.id}`, quoted(m.text, thread.id, m.id!))}
                      className="absolute top-0 right-7 rounded-md border bg-card p-1 text-muted-foreground shadow-card opacity-0 group-hover/msg:opacity-100 hover:text-foreground"
                    >
                      <Quote className="size-3.5" />
                    </button>
                  )}
                </div>
                </RowMenu>
                </Fragment>
              );
            })}
            {thread.pending && !running && <Pending pending={thread.pending} names={thread.pending.routerIds.map(rid => agents.find(a => a.id === rid)?.name ?? rid)} />}
          </div>
          </ShotScope.Provider>
          {vim.panel}
          <Composer agent="thread-input" draftKey={`thread:${thread.id}`} onSend={text => (setLine({ id }), postToThread(thread.id, "isaac", text, nudge ? "subthread" : undefined))} tools={<NudgeToggle on={nudge} set={on => setNudge(on ? "subthread" : "")} />} className="border-t px-4 py-2.5" />
        </section>

        <aside className="flex w-1/4 min-w-72 shrink-0 flex-col gap-5 overflow-y-auto pr-1">
          {objective && (
            <Section title="Objective">
              <a href={`#objective/${objective.id}`} className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
                <Waypoints className="size-3.5 text-agent" />
                {objective.title}
              </a>
            </Section>
          )}
          <Separator />
          <Section title={`Routers · ${thread.routerIds.length}`}>
            {thread.routerIds.map(rid => {
              const r = agents.find(a => a.id === rid);
              return (
                <a key={rid} href={`#agent/${rid}`} className="flex flex-col rounded-md px-1.5 py-1 hover:bg-muted">
                  <span className="flex items-center gap-1.5 text-xs">
                    <Network className="size-3 text-router" />
                    {r?.name ?? rid}
                  </span>
                  {r?.scope && <span className="truncate text-xs text-muted-foreground">{r.scope}</span>}
                </a>
              );
            })}
          </Section>
          <Separator />
          <Section title={`Mentioned · ${mentioned.size}`}>
            {mentioned.size === 0 && <p className="text-xs text-muted-foreground">None</p>}
            <div className="flex flex-wrap gap-1.5 text-sm">
              {[...mentioned.values()].map(r => (
                <RefChip key={`${r.kind}:${r.id}`} r={r} />
              ))}
            </div>
          </Section>
          <Separator />
          <Section title={`Links · ${links.size}`}>
            {links.size === 0 && <p className="text-xs text-muted-foreground">None</p>}
            {[...links.values()].map(l => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{l.label}</span>
                <span className="truncate text-xs text-muted-foreground">{new URL(l.url).hostname}</span>
              </a>
            ))}
          </Section>
        </aside>
      </div>
    </div>
  );
}

/** Off by default: on, his message asks the router to answer it in a subthread of its own rather than inline. It never takes focus, so the vim keys and the box keep it. */
function NudgeToggle({ on, set }: { on: string; set: (on: boolean) => void }) {
  return (
    <button
      type="button"
      data-agent="thread-nudge"
      aria-pressed={!!on}
      title={on ? "asking for the answer in a subthread (click to answer inline)" : "ask for the answer in a subthread"}
      onMouseDown={e => e.preventDefault()}
      onClick={() => set(!on)}
      className={cn("mt-0.5 shrink-0 rounded-md p-0.5 hover:bg-muted", on ? "text-foreground" : "text-muted-foreground/50")}
    >
      <GitBranch className="size-3.5" />
    </button>
  );
}

/** On his sent message: he asked for its answer in a subthread. */
const NudgeMark = () => (
  <span title="asked for the answer in a subthread" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
    <GitBranch className="size-2.5" />
    subthread asked
  </span>
);
