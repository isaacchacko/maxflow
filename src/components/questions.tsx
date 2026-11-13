import { useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { ago, api, type Question } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";

// A question an agent is waiting on him for, as a card on the board: clicking it opens the thread.
export function QuestionRow({ q, task, onClick }: { q: Question; task?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex shrink-0 flex-col gap-1.5 rounded-md border bg-card px-3 pt-2.5 pb-2 text-left shadow-xs transition-colors hover:border-input">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <MessageCircleQuestion className="size-3.5 shrink-0 text-sentry" />
        <span className="font-mono text-[11px]">q{q.id}</span>
        <span className="truncate">{q.name}</span>
        <span className="ml-auto shrink-0">{ago(q.at)}</span>
      </span>
      <span className="line-clamp-2 text-[13px] leading-snug text-foreground">{q.thread[0].text}</span>
      {task && <span className="truncate text-muted-foreground" title={task}>{task}</span>}
    </button>
  );
}

// The question as a comment thread: the agent's asks, his replies and the gate's notes, then his reply as the next comment.
export function QuestionThread({ q, onOpen, onSettled }: { q: Question; onOpen: (id: string) => void; onSettled: () => void }) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const settle = async (action: "reply" | "dismiss") => {
    if (action === "reply" && !reply.trim()) return;
    setSending(true);
    await api.settle(q.id, action, reply.trim());
    setSending(false);
    setReply("");
    onSettled();
  };
  const who = (from: string) => (from === "agent" ? q.name : from === "user" ? "You" : "Question gate");
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card px-4 py-3">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessageCircleQuestion className="size-3.5 text-sentry" />
        <span className="font-mono">q{q.id}</span> waits on your answer
      </h4>
      {q.thread.map((m, i) => (
        <div key={i} className="flex flex-col gap-1 text-[13px]">
          <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
            {m.from === "agent" ? (
              <button type="button" className="font-medium text-foreground hover:underline" onClick={() => onOpen(q.session)}>{who(m.from)}</button>
            ) : (
              <span className={cn("font-medium", m.from === "user" ? "text-foreground" : "text-sentry")}>{who(m.from)}</span>
            )}
            {m.at && <span>{ago(m.at)}</span>}
          </span>
          <Markdown text={m.text} />
        </div>
      ))}
      {q.default && <p className="text-xs text-muted-foreground">If unanswered, it goes ahead with: <span className="text-foreground">{q.default}</span></p>}
      <textarea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), settle("reply"))}
        rows={2}
        disabled={sending}
        placeholder={`Reply to ${q.name}…`}
        className="w-full resize-none rounded-md border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring"
      />
      <span className="flex items-center text-xs text-muted-foreground">
        ↵ sends your answer to the agent, ⇧↵ for a new line
        <button type="button" disabled={sending} className="ml-auto hover:text-foreground hover:underline" title="Close it unanswered; the agent goes with its recommendation" onClick={() => settle("dismiss")}>Dismiss</button>
      </span>
    </section>
  );
}
