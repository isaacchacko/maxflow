import { useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ago, api, type Question } from "@/lib/api";
import { cn } from "@/lib/utils";

// A question an agent is waiting on him for, answered or dismissed in place on the board.
export function QuestionCard({ q, task, onOpen, onSettled }: { q: Question; task?: string; onOpen: (id: string) => void; onSettled: () => void }) {
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
    <div className="flex shrink-0 flex-col gap-2 rounded-md border bg-card p-2.5 text-xs shadow-xs">
      <div className="flex items-baseline gap-2">
        <MessageCircleQuestion className="size-3.5 shrink-0 self-center text-sentry" />
        <span className="font-mono text-muted-foreground">q{q.id}</span>
        <button type="button" className="truncate font-medium text-foreground hover:underline" onClick={() => onOpen(q.session)}>{q.name}</button>
        <span className="ml-auto shrink-0 text-muted-foreground">{ago(q.at)}</span>
      </div>
      {task && <p className="truncate text-muted-foreground" title={task}>{task}</p>}
      {q.thread.map((m, i) => (
        <p key={i} className={cn("text-sm whitespace-pre-wrap", m.from === "agent" ? "text-foreground" : "border-l-2 pl-2 text-muted-foreground")}>{m.text}</p>
      ))}
      {q.default && <p className="text-muted-foreground">If unanswered, it goes ahead with: <span className="text-foreground">{q.default}</span></p>}
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
