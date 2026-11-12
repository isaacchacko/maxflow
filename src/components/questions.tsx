import { useState } from "react";
import { MessageCircleQuestion, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ago, api, type Question } from "@/lib/api";
import { cn } from "@/lib/utils";

const isPending = (q: Question) => q.status === "pending";

// The user's question queue: what agents asked him, oldest first, each answered or dismissed in place; then what was settled lately.
export function QuestionsPanel({ questions, onOpen, onSettled, onClose }: { questions: Question[]; onOpen: (id: string) => void; onSettled: () => void; onClose: () => void }) {
  const pending = questions.filter(isPending);
  const gating = questions.filter((q) => q.status === "gating").length;
  const settled = questions.filter((q) => !isPending(q) && q.status !== "gating").slice(-15).reverse();
  return (
    <div className="absolute top-3 right-3 bottom-3 z-30 flex w-[30rem] max-w-[calc(100%-1.5rem)] flex-col rounded-lg border bg-popover text-xs shadow-xl">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <MessageCircleQuestion className="size-4 text-sentry" />
        <span className="font-medium text-foreground">Questions</span>
        <span className="text-muted-foreground">{pending.length} waiting{gating ? ` · ${gating} at the gate` : ""}</span>
        <Button variant="ghost" size="icon" className="ml-auto size-7" title="Close" onClick={onClose}><X /></Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {!pending.length && <p className="py-6 text-center text-muted-foreground">No agent is waiting on you.</p>}
        {pending.map((q) => <Pending key={q.id} q={q} onOpen={onOpen} onSettled={onSettled} />)}
        {settled.length > 0 && (
          <section className="flex flex-col gap-2 border-t pt-3">
            <h3 className="text-[11px] tracking-wide text-muted-foreground uppercase">Settled lately</h3>
            {settled.map((q) => (
              <div key={q.id} className="flex flex-col gap-0.5 text-muted-foreground">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono">q{q.id}</span>
                  <span className={cn(q.status === "bounced" && "text-sentry")}>{q.status}</span>
                  <button type="button" className="truncate hover:text-foreground hover:underline" onClick={() => onOpen(q.session)}>{q.name}</button>
                </div>
                <p className="line-clamp-2">{q.thread[0].text}</p>
                {q.thread.length > 1 && <p className="line-clamp-2 pl-3 text-foreground/80">↳ {q.thread.at(-1)!.text}</p>}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function Pending({ q, onOpen, onSettled }: { q: Question; onOpen: (id: string) => void; onSettled: () => void }) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const settle = async (action: "reply" | "dismiss") => {
    if (action === "reply" && !reply.trim()) return;
    setSending(true);
    await api.settle(q.id, action, reply.trim());
    setSending(false);
    onSettled();
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-muted-foreground">q{q.id}</span>
        <button type="button" className="truncate font-medium text-foreground hover:underline" onClick={() => onOpen(q.session)}>{q.name}</button>
        <span className="ml-auto shrink-0 text-muted-foreground">{ago(q.at)}</span>
      </div>
      {q.thread.map((m, i) => (
        <p key={i} className={cn("text-sm whitespace-pre-wrap", m.from === "agent" ? "text-foreground" : "border-l-2 pl-2 text-muted-foreground")}>{m.text}</p>
      ))}
      <textarea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && e.metaKey && (e.preventDefault(), settle("reply"))}
        placeholder="Your answer"
        rows={2}
        className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground"><Kbd>⌘↵</Kbd> send</span>
        <Button variant="ghost" size="sm" className="ml-auto h-6" disabled={sending} title="Close it unanswered; the agent goes with its recommendation" onClick={() => settle("dismiss")}>Dismiss</Button>
        <Button size="sm" className="h-6" disabled={sending || !reply.trim()} onClick={() => settle("reply")}>Reply</Button>
      </div>
    </div>
  );
}
