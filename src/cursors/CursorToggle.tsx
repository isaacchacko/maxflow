import { MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { setShown, shownStore } from "./store";

export function CursorToggle({ open }: { open: boolean }) {
  const isShown = shownStore.use();
  const label = isShown ? "Hide agent cursors" : "Show agent cursors";
  return (
    <button
      type="button"
      onClick={() => setShown(!isShown)}
      title={label}
      aria-pressed={isShown}
      data-agent="cursors-toggle"
      className={cn("mt-auto flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap hover:bg-black/[0.04] hover:text-foreground", isShown ? "text-foreground" : "text-muted-foreground/60")}
    >
      <MousePointer2 className={cn("size-4 shrink-0", !isShown && "opacity-50")} />
      {open && <span className="flex-1 truncate text-left">{isShown ? "Cursors on" : "Cursors off"}</span>}
    </button>
  );
}
