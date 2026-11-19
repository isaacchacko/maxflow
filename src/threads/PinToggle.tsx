import { Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { setPinned } from "@/store";

export const pinLook = (isOn: boolean) => (isOn ? "bg-link/10 text-link hover:bg-link/15 hover:text-link" : "text-muted-foreground hover:bg-muted hover:text-foreground");
export const PinIcon = ({ on, className }: { on: boolean; className?: string }) => <Pin className={cn("transition-transform duration-150 motion-reduce:transition-none", on && "rotate-45 fill-current", className)} />;

export function PinToggle({ thread, className }: { thread: Thread; className?: string }) {
  const isPinned = Boolean(thread.pinned);
  return (
    <button
      data-agent="thread-pin"
      aria-pressed={isPinned}
      aria-label={isPinned ? "Unpin" : "Pin"}
      title={isPinned ? "Unpin from the sidebar" : "Pin to the sidebar"}
      onClick={() => {
        void setPinned(thread.id, !isPinned);
      }}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors", isPinned ? "border-link/30" : "border-border", pinLook(isPinned), className)}
    >
      <PinIcon on={isPinned} className="size-4" />
    </button>
  );
}
