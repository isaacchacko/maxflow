import { Quote } from "lucide-react";
import { useState } from "react";
import { useEventListener } from "@/lib/effects";
import { quoteInto, quoted } from "../Composer";

type Selected = { thread: string; message: string; text: string; x: number; y: number };

const messageHolding = (n: Node | null | undefined) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>("[data-msg]");

function selectionInOneMessage(within: HTMLElement | null): Selected | undefined {
  const sel = getSelection();
  if (!sel) return;
  const text = sel.toString().trim();
  const msg = messageHolding(sel.anchorNode);
  if (text === "" || !msg || msg !== messageHolding(sel.focusNode) || within?.contains(msg) !== true) return;
  const thread = msg.dataset["thread"];
  const message = msg.dataset["msg"];
  if (thread === undefined || message === undefined) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  return { thread, message, text, x: r.right, y: r.top };
}

export function useQuotableSelection(scrollRef: React.RefObject<HTMLElement | null>) {
  const [selected, setSelected] = useState<Selected>();
  useEventListener(
    "selectionchange",
    () => {
      setSelected(selectionInOneMessage(scrollRef.current));
    },
    { target: document },
  );
  return selected;
}

export function QuoteSelectionButton({ selected, draftKey }: { selected: Selected; draftKey: string }) {
  return (
    <button
      data-agent="quote-selection"
      onMouseDown={e => e.preventDefault()}
      onClick={() => {
        quoteInto(draftKey, quoted(selected.text, selected.thread, selected.message));
        getSelection()?.removeAllRanges();
      }}
      style={{ left: selected.x, top: selected.y - 30 }}
      className="fixed z-20 flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs shadow-raised hover:border-ring"
    >
      <Quote className="size-3" />
      Quote
    </button>
  );
}
