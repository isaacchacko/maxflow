import { Check } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { objectiveStore, setResolved, startThread, threadStore } from "@/store";
import { Composer } from "@/threads/Composer";
import { composeOnArrival } from "@/threads/jump";
import { MessageRow } from "@/threads/MessageRow";
import { Replies } from "@/threads/Replies";
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
  const rows = tops
    .filter(t => showResolved || !t.resolved || kept.has(t.id))
    .map(t => ({ t, asked: askedAt(t), last: Date.parse(t.messages.at(-1)?.at ?? "") || 0 }))
    // An agent waiting on him comes first, longest-waiting on top.
    .sort((a, b) => Number(!a.t.asks) - Number(!b.t.asks) || (a.asked ?? Infinity) - (b.asked ?? Infinity) || b.last - a.last);
  const toggle = (t: Thread) => (setKept(k => new Set(k).add(t.id)), setResolved(t.id, !t.resolved));
  const scrollRef = useRef<HTMLDivElement>(null);
  const vim = useVim("inbox", rows.map(r => r.t.id), scrollRef, "first", {
    compose: () => document.querySelector<HTMLElement>('[data-agent="inbox-input"]')?.focus(),
    open: id => (location.hash = `thread/${id}`),
    reply: id => (composeOnArrival(), (location.hash = `thread/${id}`)),
    resolve: id => {
      const t = threads.find(x => x.id === id);
      if (t) toggle(t);
    },
  });

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
      <ol className="flex max-w-4xl flex-col border empty:hidden">
        {rows.map(({ t }) => {
          // A thread a router opened before writing in it shows its title as the opening message.
          const first = t.messages[0] ?? { from: t.routerIds[0] ?? t.objectiveId, at: "", text: t.title };
          return (
            <li key={t.id} {...vimRow(t.id)} className="group relative border-b px-3 py-2 last:border-b-0">
              <button
                data-agent={`inbox-resolve:${t.id}`}
                title={t.resolved ? "Reopen" : "Resolve"}
                onClick={() => toggle(t)}
                className={cn("absolute top-2 right-3 z-10 border p-1 hover:border-ring", t.resolved ? "text-emerald-400" : "bg-background text-muted-foreground opacity-0 group-hover:opacity-100")}
              >
                <Check className="size-3.5" />
              </button>
              <div className={cn(t.resolved && "opacity-50")}>
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
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
