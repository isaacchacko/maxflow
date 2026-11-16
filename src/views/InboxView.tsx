import { Check, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { objectiveStore, startThread, threadStore } from "@/store";
import { Composer } from "@/threads/Composer";

function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}

/** A thread asks for Isaac from the first message after his last reply; null once he has answered everything in it. */
function askedAt(t: Thread) {
  const lastMine = t.messages.findLastIndex(m => m.from === "isaac");
  const ask = t.messages.slice(lastMine + 1)[0];
  return ask ? Date.parse(ask.at) : null;
}

const plain = (text: string) => text.replace(/!\[[^\]]*\]\([^)]+\)/g, "[image]").replace(/\[\[\w+:([^\]]+)\]\]/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

export function InboxView() {
  const threads = threadStore.use();
  const objectives = objectiveStore.use();
  const [showResolved, setShowResolved] = useState(false);
  const resolved = threads.filter(t => t.resolved).length;
  const rows = threads
    .filter(t => showResolved || !t.resolved)
    .map(t => ({ t, asked: askedAt(t), last: Date.parse(t.messages.at(-1)?.at ?? "") || 0 }))
    .sort((a, b) => (a.asked ?? Infinity) - (b.asked ?? Infinity) || b.last - a.last);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <Composer autoFocus agent="inbox-input" draftKey="inbox" onSend={startThread} className="max-w-4xl border px-3 py-2.5" />
      {resolved > 0 && (
        <button data-agent="inbox-resolved" onClick={() => setShowResolved(v => !v)} className={cn("flex w-fit items-center gap-1.5 border px-2 py-0.5 text-xs text-muted-foreground hover:border-ring", showResolved && "border-ring text-foreground")}>
          <Check className="size-3" />
          Resolved ({resolved})
        </button>
      )}
      <ol className="flex max-w-4xl flex-col border empty:hidden">
        {rows.map(({ t, asked, last }) => {
          const latest = t.messages.at(-1);
          return (
            <li key={t.id} className="border-b last:border-b-0">
              <a href={`#thread/${t.id}`} data-agent={`inbox:${t.id}`} className={cn("flex items-center gap-3 px-3 py-2 hover:bg-muted", (asked === null || t.resolved) && "opacity-50")}>
                {t.resolved ? <Check className="size-3 shrink-0 text-muted-foreground" /> : <span className={cn("size-2 shrink-0", asked === null ? "bg-muted-foreground/40" : "bg-sky-400")} />}
                <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="w-64 shrink-0 truncate text-sm">{t.title}</span>
                <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">{t.objectiveId ? objectives.find(o => o.id === t.objectiveId)?.title : "routing…"}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{latest && plain(latest.text)}</span>
                <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{ago(asked ?? last)}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
