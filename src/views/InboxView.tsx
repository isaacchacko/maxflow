import { AlarmClock, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentFace } from "@/components/AgentFace";
import { card, surface } from "@/lib/surface";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { markAskShown, objectiveStore, setKind, setResolved, startThread, threadStore } from "@/store";
import { Composer } from "@/threads/Composer";
import { arrivedFrom, composeOnArrival, flash, useLayerScroll } from "@/threads/jump";
import { MessageRow, when } from "@/threads/MessageRow";
import { FeedTag } from "@/threads/FeedTag";
import { KINDS } from "@/threads/KindMenu";
import { ago, Replies } from "@/threads/Replies";
import { Rich } from "@/threads/Rich";
import { RowMenu, threadItems, type MenuItem } from "@/threads/RowMenu";
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

const firstLine = (text: string) => text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim().split("\n")[0] ?? "";
const today = (at: string) => new Date(at).toDateString() === new Date().toDateString();

/** Wide enough for the commands to have a column of their own beside the conversations. */
const WIDE = "(min-width: 1100px)";
function useWide() {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const m = matchMedia(WIDE);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

/**
 * A command he gave: one line, ✻ while its router works and ✓ with the result its router posted; open, it shows the exchange.
 * Compact, in the sidebar, the line is the glyph, the ask and its age, with the result on hover and the buttons in place of the age.
 */
function CommandRow({ t, active, open, compact, menu, onToggle, onResolve }: { t: Thread; active: boolean; open: boolean; compact?: boolean; menu: (MenuItem | false | undefined)[]; onToggle(): void; onResolve(): void }) {
  const asked = t.messages.find(m => m.from === "isaac") ?? t.messages[0];
  const result = t.done ? (t.messages.findLast(m => m.re) ?? t.messages.at(-1)) : undefined;
  const last = t.messages.at(-1)?.at ?? "";
  const status = result ? firstLine(result.text) : t.pending?.status ? `${t.pending.status}…` : "router working on it…";
  return (
    <RowMenu agent={t.id} items={menu}>
    <li {...vimRow(t.id)} className={cn("group", card)}>
      <div
        data-agent={`command:${t.id}`}
        onClick={e => (e.target as Element).closest("a, button") || onToggle()}
        title={compact ? status : undefined}
        className={cn("flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm hover:bg-muted/50", active && "bg-muted/60 shadow-[inset_2px_0_0_var(--color-link)]", (t.resolved || t.paused) && "opacity-50")}
      >
        {result ? <Check className="size-3.5 shrink-0 text-ok" /> : <AgentFace id={t.routerIds[0] ?? t.id} expression="thinking" small className="size-5" />}
        {/* In the column, the result shares the line with the ask once the column is 28rem wide, and is on hover until then. */}
        <Rich still text={firstLine(asked?.text ?? t.title) || t.title} className={cn("truncate", compact ? "min-w-0 flex-1" : "w-80 shrink-0")} />
        <span className={cn("min-w-0 flex-1 truncate text-xs text-muted-foreground", compact && "hidden @md:block")}>
          <Rich still text={status} />
        </span>
        <button
          data-agent={`talk-it-through:${t.id}`}
          title="Make it a conversation: its router keeps the thread open and talks it through with you"
          onClick={() => setKind(t.id, "conversation")}
          className={cn("flex shrink-0 items-center gap-1 rounded-full border bg-card px-2 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:border-ring hover:text-foreground", compact && "hidden py-0.5 group-hover:flex")}
        >
          <KINDS.conversation.icon className="size-3" />
          {!compact && "talk it through"}
        </button>
        <button data-agent={`inbox-resolve:${t.id}`} title={t.resolved ? "Reopen" : "Resolve"} onClick={onResolve} className={cn("shrink-0 rounded-md border bg-card p-0.5 hover:border-ring", t.resolved ? "text-ok" : "text-muted-foreground opacity-0 group-hover:opacity-100", compact && "hidden group-hover:block")}>
          <Check className="size-3" />
        </button>
        <span className={cn("w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums", compact && "group-hover:hidden")}>{last && ago(Date.parse(last))}</span>
      </div>
      {open && (
        <div className={cn("rounded-b-xl border-t bg-muted/30 py-2", compact ? "px-3" : "px-5")}>
          <ShotScope.Provider value={shotsOf(t.messages)}>
            {t.messages.map((m, i) => (
              <MessageRow key={m.id ?? i} from={m.from} at={m.at} text={m.text} />
            ))}
          </ShotScope.Provider>
          {!result && t.pending && <p className="text-xs text-muted-foreground">waiting since {when(t.pending.since)}</p>}
          <a href={`#thread/${t.id}`} className="mt-1 inline-block text-xs text-link hover:underline">
            open the thread
          </a>
        </div>
      )}
    </li>
    </RowMenu>
  );
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
  // Commands sit in a strip of their own above the conversations, today's in view and older ones behind a toggle.
  const [earlier, setEarlier] = useState(false);
  const [opened, setOpened] = useState<string>();
  // An agent waiting on him stays on top of everything, the strip included.
  const needsYou = rows.filter(r => r.t.asks);
  const allCommands = rows.filter(r => !r.t.asks && r.t.kind === "command");
  const commands = allCommands.filter(r => earlier || today(r.t.messages.at(-1)?.at ?? r.t.messages[0]?.at ?? ""));
  const conversations = rows.filter(r => !r.t.asks && r.t.kind !== "command");
  // Wide, the commands sit in a sticky column on the right; narrow, in a strip above the conversations, its first 3 until he asks.
  const wide = useWide();
  const [more, setMore] = useState(false);
  const shown = wide || more ? commands : commands.slice(0, 3);
  const toggle = (t: Thread) => (setKept(k => new Set(k).add(t.id)), setResolved(t.id, !t.resolved));
  // Drawing an ask flagged, on a page he has in front of him, starts the clock on its agent's default.
  const unshown = rows.filter(r => r.t.asks && !r.t.asks.shown).map(r => r.t.id);
  useEffect(() => {
    if (document.visibilityState === "visible") for (const id of unshown) markAskShown(id);
  }, [unshown.join()]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  // A command row opens in place; a conversation opens its thread.
  const open = (id: string) => (commands.some(r => r.t.id === id) ? setOpened(o => (o === id ? undefined : id)) : (location.hash = `thread/${id}`));
  const reply = (id: string) => (composeOnArrival(), (location.hash = `thread/${id}`));
  // Right-click offers what the keys do, on the row it was clicked on.
  // Paused from this list, a row stays put like a resolved one, so he sees it took.
  const pause = (id: string) => (setKept(k => new Set(k).add(id)), openPause(id));
  const menu = (t: Thread) => threadItems(t, threads, { open: () => open(t.id), reply: () => reply(t.id), resolve: () => toggle(t), pause: () => pause(t.id) });
  // j/k walk the page in reading order: the asks, then the conversations and the commands' column, or the strip above them.
  const main = [...needsYou, ...conversations].map(r => r.t.id);
  const side = shown.map(r => r.t.id);
  const vim = useVim("inbox", wide ? [...main, ...side] : [...needsYou.map(r => r.t.id), ...side, ...conversations.map(r => r.t.id)], scrollRef, "first", {
    compose: () => document.querySelector<HTMLElement>('[data-agent="inbox-input"]')?.focus(),
    open,
    reply,
    resolve: id => {
      const t = threads.find(x => x.id === id);
      if (t) toggle(t);
    },
    pause: id => id && pause(id),
    // ] jumps to the commands, [ back to the asks and conversations.
    section: dir => (dir > 0 ? side[0] : main[0]),
  });
  // Back up out of a thread, the list and the commands column are where he left them, and that thread's row takes the cursor and flashes.
  useLayerScroll("inbox", scrollRef);
  useLayerScroll("inbox:commands", asideRef);
  useEffect(() => {
    const from = arrivedFrom();
    const row = from && scrollRef.current?.querySelector(`[data-vim="${CSS.escape(from)}"]`);
    if (row) vim.move(from, false), flash(row);
  }, []);

  const conversationRow = (t: Thread) => {
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
          <button
            data-agent={`just-do-it:${t.id}`}
            title="Make it a command: its router acts on it and answers once, with the result"
            onClick={() => setKind(t.id, "command")}
            className="absolute top-2.5 right-11 z-10 flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs shadow-card text-muted-foreground opacity-0 group-hover:opacity-100 hover:border-ring hover:text-foreground"
          >
            <KINDS.command.icon className="size-3 text-command" />
            just do it
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

  const strip = allCommands.length > 0 && (
    <section data-agent="inbox-commands" className="flex flex-col gap-1">
      <h2 className="flex items-center gap-2 px-1 text-[13px] font-medium text-muted-foreground">
        <KINDS.command.icon className="size-3 text-command" />
        Commands · {earlier ? "all" : "today"}
      </h2>
      <ol className={cn(surface, "empty:hidden")}>
        {shown.map(({ t }) => (
          <CommandRow key={t.id} t={t} compact={wide} active={vim.cursor === t.id} open={opened === t.id} menu={menu(t)} onToggle={() => setOpened(o => (o === t.id ? undefined : t.id))} onResolve={() => toggle(t)} />
        ))}
      </ol>
      <p className="flex gap-3 px-1 text-xs text-muted-foreground empty:hidden">
        {!wide && commands.length > 3 && (
          <button data-agent="inbox-commands-more" onClick={() => setMore(v => !v)} className="hover:text-foreground">
            {more ? "show 3" : `+ ${commands.length - 3} more`}
          </button>
        )}
        {(allCommands.length > commands.length || earlier) && (
          <button data-agent="inbox-commands-earlier" onClick={() => setEarlier(v => !v)} className="hover:text-foreground">
            {earlier ? "today only" : `+ ${allCommands.length - commands.length} earlier`}
          </button>
        )}
      </p>
    </section>
  );

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
        {needsYou.length > 0 && <ol className={cn(surface, "bg-warn-soft/70")}>{needsYou.map(({ t }) => conversationRow(t))}</ol>}
        {!wide && strip}
        {!wide && strip && conversations.length > 0 && <h2 className="px-1 text-[13px] font-medium text-muted-foreground">Conversations</h2>}
        <ol className={cn(surface, "empty:hidden")}>{conversations.map(({ t }) => conversationRow(t))}</ol>
      </div>
      {/* Sticky, so the commands stay in view while the conversations scroll under them. */}
      {wide && strip && <aside ref={asideRef} className="@container sticky top-0 max-h-[calc(100dvh-6rem)] max-w-5xl min-w-70 flex-1 self-start overflow-y-auto">{strip}</aside>}
    </div>
  );
}
