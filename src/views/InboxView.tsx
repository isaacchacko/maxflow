import { Check } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { agentStore, objectiveStore, setResolved, startThread, threadStore } from "@/store";
import { Composer } from "@/threads/Composer";
import { MessageRow } from "@/threads/MessageRow";
import { Avatar } from "@/threads/Rich";
import { seenCount } from "@/threads/seen";
import { Pending } from "@/threads/ThreadPage";

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

/** Replies he hasn't had on screen; a thread this browser never opened counts what came after his last message. */
function unseen(t: Thread) {
  const seen = seenCount(t.id);
  return seen === null ? t.messages.length - 1 - t.messages.findLastIndex(m => m.from === "isaac") : Math.max(0, t.messages.length - seen);
}

/** Under the opening message, as Slack does: who replied, how many, and when last; or the router still working on it. */
function Replies({ t }: { t: Thread }) {
  const agents = agentStore.use();
  const replies = t.messages.slice(1);
  const fresh = unseen(t);
  const faces = [...new Set(replies.map(m => m.from).reverse())].slice(0, 4);
  return (
    <a href={`#thread/${t.id}`} data-agent={`inbox:${t.id}`} className="mt-1 flex w-fit items-center gap-2 border border-transparent py-0.5 pr-2 text-xs hover:border-border hover:bg-background">
      {faces.length > 0 && (
        <span className="flex gap-0.5">
          {faces.map(f => (
            <Avatar key={f} from={f} small />
          ))}
        </span>
      )}
      {replies.length > 0 ? <span className="font-semibold text-sky-400">{replies.length === 1 ? "1 reply" : `${replies.length} replies`}</span> : !t.pending && <span className="text-muted-foreground">No replies yet</span>}
      {fresh > 0 && <span className="bg-rose-500/15 px-1 font-medium text-rose-400">{fresh} new</span>}
      {t.pending ? (
        <Pending pending={t.pending} names={t.pending.routerIds.map(rid => agents.find(a => a.id === rid)?.name ?? rid)} />
      ) : (
        replies.length > 0 && <span className="text-muted-foreground">Last reply {ago(Date.parse(replies.at(-1)!.at))} ago</span>
      )}
    </a>
  );
}

export function InboxView() {
  const threads = threadStore.use();
  const objectives = objectiveStore.use();
  const [showResolved, setShowResolved] = useState(false);
  // Resolved from this list, a row stays put until he leaves the inbox, so a second click undoes an accidental resolve.
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  const resolved = threads.filter(t => t.resolved).length;
  const rows = threads
    .filter(t => showResolved || !t.resolved || kept.has(t.id))
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
        {rows.map(({ t }) => {
          // A thread a router opened before writing in it shows its title as the opening message.
          const first = t.messages[0] ?? { from: t.routerIds[0] ?? t.objectiveId, at: "", text: t.title };
          return (
            <li key={t.id} className="group relative border-b px-3 py-2 last:border-b-0">
              <button
                data-agent={`inbox-resolve:${t.id}`}
                title={t.resolved ? "Reopen" : "Resolve"}
                onClick={() => (setKept(k => new Set(k).add(t.id)), setResolved(t.id, !t.resolved))}
                className={cn("absolute top-2 right-3 z-10 border p-1 hover:border-ring", t.resolved ? "text-emerald-400" : "bg-background text-muted-foreground opacity-0 group-hover:opacity-100")}
              >
                <Check className="size-3.5" />
              </button>
              <div className={cn(t.resolved && "opacity-50")}>
                <MessageRow
                  from={first.from}
                  at={first.at}
                  text={first.text}
                  className="cursor-pointer"
                  // A long opener or a pasted screenshot stays a preview here; the thread has it in full.
                  bodyClassName="max-h-36 overflow-hidden [&_img]:max-h-28"
                  // The whole row opens the thread, except the links and chips inside the message.
                  onClick={e => (e.target as Element).closest("a") || (location.hash = `thread/${t.id}`)}
                  meta={
                    <span className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{t.objectiveId ? objectives.find(o => o.id === t.objectiveId)?.title : "routing…"}</span>
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
