import { Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { setPinned } from "@/store";

/** How a pin reads, on or off, wherever one is a toggle: off an outlined pin, muted; on a filled pin in the accent, tilted, on a tint. */
export const pinLook = (on: boolean) => (on ? "bg-link/10 text-link hover:bg-link/15 hover:text-link" : "text-muted-foreground hover:bg-muted hover:text-foreground");
export const PinIcon = ({ on, className }: { on: boolean; className?: string }) => <Pin className={cn("transition-transform duration-150 motion-reduce:transition-none", on && "rotate-45 fill-current", className)} />;

/** A thread's pin as a toggle button: pinned to the sidebar or not, at a glance (Isaac: make the pinned button more obvious). */
export function PinToggle({ thread, className }: { thread: Thread; className?: string }) {
  const on = !!thread.pinned;
  return (
    <button
      data-agent="thread-pin"
      aria-pressed={on}
      aria-label={on ? "Unpin" : "Pin"}
      title={on ? "Unpin from the sidebar" : "Pin to the sidebar"}
      onClick={() => void setPinned(thread.id, !on)}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors", on ? "border-link/30" : "border-border", pinLook(on), className)}
    >
      <PinIcon on={on} className="size-4" />
    </button>
  );
}
