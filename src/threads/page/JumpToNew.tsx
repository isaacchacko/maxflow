import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useState } from "react";
import { highlight } from "../jump";

const rowIn = (scroller: HTMLElement, key: string) => scroller.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);

function useNewSpots(threadId: string, newKeys: string[], scrollRef: React.RefObject<HTMLElement | null>) {
  const [spots, setSpots] = useState<{ id: string; of: Record<string, "above" | "below" | "met"> }>({ id: threadId, of: {} });
  if (spots.id !== threadId) setSpots({ id: threadId, of: {} });
  const keys = newKeys.join("\n");
  const watch = useCallback(
    (el: HTMLElement | null) => {
      const scroller = scrollRef.current;
      if (!el || !scroller || keys === "") return;
      const observer = new IntersectionObserver(
        entries =>
          setSpots(prev => {
            const of = { ...prev.of };
            for (const e of entries) {
              const key = (e.target as HTMLElement).dataset["row"] ?? "";
              if (of[key] === "met") continue;
              if (e.isIntersecting) of[key] = "met";
              else of[key] = e.boundingClientRect.top < (e.rootBounds?.top ?? 0) ? "above" : "below";
            }
            return { ...prev, of };
          }),
        { root: scroller, rootMargin: "0px 0px -40px 0px" },
      );
      for (const key of keys.split("\n")) {
        const row = rowIn(scroller, key);
        if (row) observer.observe(row);
      }
      return () => observer.disconnect();
    },
    [keys, scrollRef],
  );
  const unmet = newKeys.filter(k => spots.of[k] === "above" || spots.of[k] === "below");
  return { watch, unmet, spotOf: (k: string) => spots.of[k] };
}

export function JumpToNew({ threadId, newKeys, scrollRef }: { threadId: string; newKeys: string[]; scrollRef: React.RefObject<HTMLElement | null> }) {
  const { watch, unmet, spotOf } = useNewSpots(threadId, newKeys, scrollRef);
  const first = unmet[0];
  const isUp = first !== undefined && spotOf(first) === "above";
  const jump = () => {
    const row = first === undefined || !scrollRef.current ? null : rowIn(scrollRef.current, first);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    highlight(row);
  };
  const Chevron = isUp ? ChevronUp : ChevronDown;
  return (
    <div ref={watch} className={isUp ? "absolute top-2 right-3" : "absolute right-3 bottom-2"}>
      {first !== undefined && (
        <button
          type="button"
          data-agent="jump-to-new"
          title={isUp ? "Jump up to the first new message" : "Jump down to the first new message"}
          onClick={jump}
          className="flex items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs font-semibold text-destructive shadow-sm hover:bg-muted"
        >
          {unmet.length} new
          <Chevron className="size-3.5" />
        </button>
      )}
    </div>
  );
}
