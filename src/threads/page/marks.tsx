import { ArrowUpToLine, Check, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { raisedTo } from "../Raise";

export function NudgeToggle({ on, set }: { on: string; set: (isOn: boolean) => void }) {
  const isOn = on !== "";
  return (
    <button
      type="button"
      data-agent="thread-nudge"
      aria-pressed={isOn}
      onMouseDown={e => e.preventDefault()}
      onClick={() => set(!isOn)}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
    >
      <GitBranch className={cn("size-3.5 shrink-0", isOn ? "text-link" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1">Ask for the answer in a subthread</span>
      {isOn && <Check className="size-3.5 shrink-0 text-link" />}
    </button>
  );
}

export function RaisedMark({ threads, thread, message }: { threads: Thread[]; thread: string; message: string }) {
  const to = raisedTo(threads, thread, message);
  return to.map(t => (
    <a key={t.id} href={`#thread/${t.id}`} data-agent={`raised:${t.id}`} title={t.title} className="mt-0.5 flex w-fit max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowUpToLine className="size-3 shrink-0" />
      <span className="truncate">raised to {t.title}</span>
    </a>
  ));
}

export const NudgeMark = () => (
  <span title="asked for the answer in a subthread" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
    <GitBranch className="size-2.5" />
    subthread asked
  </span>
);

export const WakeMark = () => (
  <span data-agent="wake-mark" title="written when he paused the thread, sent as it woke" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
    ⏰ sent on wake
  </span>
);

export function EarlierInTheConversationLine() {
  return (
    <p className="my-2 flex items-center gap-2 text-[11px] text-muted-foreground">
      earlier in this conversation
      <span className="h-px flex-1 bg-border" />
    </p>
  );
}

const SLACK_CHANNEL_OR_GITHUB_PR = /archives\/(\w+)|github\.com\/([\w.-]+\/[\w.-]+\/\w+\/\d+)/;

export const conversationOf = (link = "") => SLACK_CHANNEL_OR_GITHUB_PR.exec(link)?.slice(1).find(Boolean);

export function MessageMarks({ message, threads, thread }: { message: Thread["messages"][number]; threads: Thread[]; thread: string }) {
  return (
    <>
      {message.nudge === "subthread" && <NudgeMark />}
      {message.wake === true && <WakeMark />}
      {message.id !== undefined && message.id !== "" && <RaisedMark threads={threads} thread={thread} message={message.id} />}
    </>
  );
}
