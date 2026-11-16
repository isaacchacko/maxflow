import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { markAskShown, objectiveStore, setKind, setResolved, startThread, threadStore } from "@/store";
import { Composer } from "@/threads/Composer";
import { composeOnArrival } from "@/threads/jump";
import { MessageRow, when } from "@/threads/MessageRow";
import { KINDS } from "@/threads/KindMenu";
import { ago, Replies } from "@/threads/Replies";
import { Rich } from "@/threads/Rich";
import { RowMenu, threadItems, type MenuItem } from "@/threads/RowMenu";
import { ShotScope, shotsOf } from "@/threads/Viewer";
import { useVim, vimRow } from "@/threads/vim";

/** A thread asks for Isaac from the first message after his last reply; null once he has answered everything in it. */
function askedAt(t: Thread) {
  const lastMine = t.messages.findLastIndex(m => m.from === "isaac");
  const ask = t.messages.slice(lastMine + 1)[0];
  return ask ? Date.parse(ask.at) : null;
}

const firstLine = (text: string) => text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim().split("\n")[0] ?? "";
const today = (at: string) => new Date(at).toDateString() === new Date().toDateString();

/** A command he gave: one line, ✻ while its router works and ✓ with the result its router posted; open, it shows the exchange. */
function CommandRow({ t, active, open, menu, onToggle, onResolve }: { t: Thread; active: boolean; open: boolean; menu: (MenuItem | false | undefined)[]; onToggle(): void; onResolve(): void }) {
  const asked = t.messages.find(m => m.from === "isaac") ?? t.messages[0];
  const result = t.done ? (t.messages.findLast(m => m.re) ?? t.messages.at(-1)) : undefined;
  const last = t.messages.at(-1)?.at ?? "";
  return (
    <RowMenu agent={t.id} items={menu}>
    <li {...vimRow(t.id)} className="group border-b last:border-b-0">
      <div
        data-agent={`command:${t.id}`}
        onClick={e => (e.target as Element).closest("a, button") || onToggle()}
        className={cn("flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-muted/40", active && "bg-muted/40 shadow-[inset_2px_0_0_var(--color-sky-400)]", t.resolved && "opacity-50")}
      >
        {result ? <Check className="size-3.5 shrink-0 text-emerald-400" /> : <span className="inline-block w-3.5 shrink-0 animate-spin text-center text-agent">✻</span>}
        <Rich still text={firstLine(asked?.text ?? t.title) || t.title} className="w-80 shrink-0 truncate" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {result ? <Rich still text={firstLine(result.text)} /> : t.pending?.status ? <Rich still text={`${t.pending.status}…`} /> : "router working on it…"}
        </span>
        <button
          data-agent={`talk-it-through:${t.id}`}
          title="Make it a conversation: its router keeps the thread open and talks it through with you"
          onClick={() => setKind(t.id, "conversation")}
          className="flex shrink-0 items-center gap-1 border px-1.5 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:border-ring hover:text-foreground"
        >
          <KINDS.conversation.icon className="size-3" />
          talk it through
        </button>
        <button data-agent={`inbox-resolve:${t.id}`} title={t.resolved ? "Reopen" : "Resolve"} onClick={onResolve} className={cn("shrink-0 border p-0.5 hover:border-ring", t.resolved ? "text-emerald-400" : "text-muted-foreground opacity-0 group-hover:opacity-100")}>
          <Check className="size-3" />
        </button>
        <span className="w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{last && ago(Date.parse(last))}</span>
      </div>
      {open && (
        <div className="border-t bg-muted/15 px-5 py-2">
          <ShotScope.Provider value={shotsOf(t.messages)}>
            {t.messages.map((m, i) => (
              <MessageRow key={m.id ?? i} from={m.from} at={m.at} text={m.text} />
            ))}
          </ShotScope.Provider>
          {!result && t.pending && <p className="text-xs text-muted-foreground">waiting since {when(t.pending.since)}</p>}
          <a href={`#thread/${t.id}`} className="mt-1 inline-block text-xs text-sky-400 hover:underline">
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
  const rows = tops
    .filter(t => showResolved || !t.resolved || kept.has(t.id))
    .map(t => ({ t, asked: askedAt(t), last: Date.parse(t.messages.at(-1)?.at ?? "") || 0 }))
    // An agent waiting on him comes first, longest-waiting on top.
    .sort((a, b) => Number(!a.t.asks) - Number(!b.t.asks) || (a.asked ?? Infinity) - (b.asked ?? Infinity) || b.last - a.last);
  // Commands sit in a strip of their own above the conversations, today's in view and older ones behind a toggle.
  const [earlier, setEarlier] = useState(false);
  const [opened, setOpened] = useState<string>();
  // An agent waiting on him stays on top of everything, the strip included.
  const needsYou = rows.filter(r => r.t.asks);
  const allCommands = rows.filter(r => !r.t.asks && r.t.kind === "command");
  const commands = allCommands.filter(r => earlier || today(r.t.messages.at(-1)?.at ?? r.t.messages[0]?.at ?? ""));
  const conversations = rows.filter(r => !r.t.asks && r.t.kind !== "command");
  const toggle = (t: Thread) => (setKept(k => new Set(k).add(t.id)), setResolved(t.id, !t.resolved));
  // Drawing an ask flagged, on a page he has in front of him, starts the clock on its agent's default.
  const unshown = rows.filter(r => r.t.asks && !r.t.asks.shown).map(r => r.t.id);
  useEffect(() => {
    if (document.visibilityState === "visible") for (const id of unshown) markAskShown(id);
  }, [unshown.join()]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // A command row opens in place; a conversation opens its thread.
  const open = (id: string) => (commands.some(r => r.t.id === id) ? setOpened(o => (o === id ? undefined : id)) : (location.hash = `thread/${id}`));
  const reply = (id: string) => (composeOnArrival(), (location.hash = `thread/${id}`));
  // Right-click offers what the keys do, on the row it was clicked on.
  const menu = (t: Thread) => threadItems(t, threads, { open: () => open(t.id), reply: () => reply(t.id), resolve: () => toggle(t) });
  const vim = useVim("inbox", [...needsYou, ...commands, ...conversations].map(r => r.t.id), scrollRef, "first", {
    compose: () => document.querySelector<HTMLElement>('[data-agent="inbox-input"]')?.focus(),
    open,
    reply,
    resolve: id => {
      const t = threads.find(x => x.id === id);
      if (t) toggle(t);
    },
  });

  const conversationRow = (t: Thread) => {
      // A thread a router opened before writing in it shows its title as the opening message.
      const first = t.messages[0] ?? { from: t.routerIds[0] ?? t.objectiveId, at: "", text: t.title };
      return (
        <RowMenu key={t.id} agent={t.id} items={menu(t)}>
        <li {...vimRow(t.id)} className="group relative border-b px-3 py-2 last:border-b-0">
          <button
            data-agent={`inbox-resolve:${t.id}`}
            title={t.resolved ? "Reopen" : "Resolve"}
            onClick={() => toggle(t)}
            className={cn("absolute top-2 right-3 z-10 border p-1 hover:border-ring", t.resolved ? "text-emerald-400" : "bg-background text-muted-foreground opacity-0 group-hover:opacity-100")}
          >
            <Check className="size-3.5" />
          </button>
          <button
            data-agent={`just-do-it:${t.id}`}
            title="Make it a command: its router acts on it and answers once, with the result"
            onClick={() => setKind(t.id, "command")}
            className="absolute top-2 right-11 z-10 flex items-center gap-1 border bg-background px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:border-ring hover:text-foreground"
          >
            <KINDS.command.icon className="size-3 text-amber-400" />
            just do it
          </button>
          <div className={cn(t.resolved && "opacity-50")}>
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
                  {t.asks && <span className="shrink-0 font-medium text-amber-400">needs you</span>}
                  <span className="truncate">{t.objectiveId ? objectives.find(o => o.id === t.objectiveId)?.title : t.asks ? "" : "routing…"}</span>
                  {t.resolved && <Check className="size-3 shrink-0 self-center" />}
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
    <div ref={scrollRef} className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      {vim.panel}
      <Composer autoFocus agent="inbox-input" draftKey="inbox" onSend={startThread} className="max-w-4xl border px-3 py-2.5" />
      {resolved > 0 && (
        <button data-agent="inbox-resolved" onClick={() => setShowResolved(v => !v)} className={cn("flex w-fit items-center gap-1.5 border px-2 py-0.5 text-xs text-muted-foreground hover:border-ring", showResolved && "border-ring text-foreground")}>
          <Check className="size-3" />
          Resolved ({resolved})
        </button>
      )}
      {needsYou.length > 0 && <ol className="flex max-w-4xl flex-col border border-amber-400/40">{needsYou.map(({ t }) => conversationRow(t))}</ol>}
      {allCommands.length > 0 && (
        <section data-agent="inbox-commands" className="flex max-w-4xl flex-col gap-1">
          <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <KINDS.command.icon className="size-3 text-amber-400" />
            Commands · {earlier ? "all" : "today"}
            {allCommands.length > commands.length || earlier ? (
              <button data-agent="inbox-commands-earlier" onClick={() => setEarlier(v => !v)} className="font-normal tracking-normal normal-case hover:text-foreground">
                {earlier ? "today only" : `+ ${allCommands.length - commands.length} earlier`}
              </button>
            ) : null}
          </h2>
          <ol className="flex flex-col border empty:hidden">
            {commands.map(({ t }) => (
              <CommandRow key={t.id} t={t} active={vim.cursor === t.id} open={opened === t.id} menu={menu(t)} onToggle={() => setOpened(o => (o === t.id ? undefined : t.id))} onResolve={() => toggle(t)} />
            ))}
          </ol>
        </section>
      )}
      {allCommands.length > 0 && conversations.length > 0 && <h2 className="max-w-4xl text-xs font-semibold tracking-wide text-muted-foreground uppercase">Conversations</h2>}
      <ol className="flex max-w-4xl flex-col border empty:hidden">
        {conversations.map(({ t }) => conversationRow(t))}
      </ol>
    </div>
  );
}
