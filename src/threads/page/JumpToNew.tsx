import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useLatest } from "@/lib/effects";
import { highlight } from "../jump";
import { NewCount } from "../NewCount";

const rowIn = (scroller: HTMLElement, key: string) => scroller.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);

type Props = { threadId: string; newKeys: string[]; scrollRef: React.RefObject<HTMLElement | null>; onSeenThrough: (key: string) => void };

function useNewSpots({ threadId, newKeys, scrollRef, onSeenThrough }: Props) {
  const met = useRef({ id: threadId, keys: new Set<string>() });
  const latestSeenThrough = useLatest(onSeenThrough);
  const [spots, setSpots] = useState<{ id: string; of: Record<string, "above" | "below" | "met"> }>({ id: threadId, of: {} });
  if (spots.id !== threadId) setSpots({ id: threadId, of: {} });
  const keys = newKeys.join("\n");
  const watch = useCallback(
    (el: HTMLElement | null) => {
      const scroller = scrollRef.current;
      if (!el || !scroller || keys === "") return;
      if (met.current.id !== threadId) met.current = { id: threadId, keys: new Set() };
      const shown = keys.split("\n").filter(key => rowIn(scroller, key));
      const markReadThroughFirstUnmet = () => {
        const firstUnmet = shown.findIndex(key => !met.current.keys.has(key));
        const through = (firstUnmet === -1 ? shown : shown.slice(0, firstUnmet)).at(-1);
        if (through !== undefined) latestSeenThrough.current(through);
      };
      const observer = new IntersectionObserver(
        entries => {
          for (const e of entries) if (e.isIntersecting) met.current.keys.add((e.target as HTMLElement).dataset["row"] ?? "");
          markReadThroughFirstUnmet();
          setSpots(prev => {
            const of = { ...prev.of };
            for (const e of entries) {
              const key = (e.target as HTMLElement).dataset["row"] ?? "";
              if (of[key] === "met") continue;
              if (e.isIntersecting) of[key] = "met";
              else of[key] = e.boundingClientRect.top < (e.rootBounds?.top ?? 0) ? "above" : "below";
            }
            return { ...prev, of };
          });
        },
        { root: scroller, rootMargin: "0px 0px -40px 0px" },
      );
      for (const key of shown) {
        const row = rowIn(scroller, key);
        if (row) observer.observe(row);
      }
      return () => observer.disconnect();
    },
    [keys, threadId, scrollRef, latestSeenThrough],
  );
  const unmet = newKeys.filter(k => spots.of[k] === "above" || spots.of[k] === "below");
  return { watch, unmet, spotOf: (k: string) => spots.of[k] };
}

export function JumpToNew(props: Props) {
  const { scrollRef } = props;
  const { watch, unmet, spotOf } = useNewSpots(props);
  const first = unmet[0];
  const isUp = first !== undefined && spotOf(first) === "above";
  const jump = () => {
    const row = first === undefined || !scrollRef.current ? null : rowIn(scrollRef.current, first);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    highlight(row);
  };
  return (
    <div ref={watch} className={isUp ? "absolute top-2 right-3" : "absolute right-3 bottom-2"}>
      {first !== undefined && (
        <button
          type="button"
          data-agent="jump-to-new"
          title={isUp ? "Jump up to the first new message" : "Jump down to the first new message"}
          onClick={jump}
          className="flex rounded-full bg-background text-xs shadow-sm hover:brightness-95"
        >
          <NewCount count={unmet.length} arrow={isUp ? ChevronUp : ChevronDown} />
        </button>
      )}
    </div>
  );
}
