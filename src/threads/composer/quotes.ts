import { useCallback } from "react";
import { useEventListener, useLatest } from "@/lib/effects";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { isRecord } from "../../../shared/guards";

const quotesWaitingForTheirComposer = new Map<string, string>();

const joinParagraphs = (...parts: (string | undefined)[]) => parts.filter(Boolean).join("\n\n");

export function quoteInto(draftKey: string, markdown: string) {
  const isUnclaimed = dispatchEvent(new CustomEvent("composer-quote", { detail: { draftKey, markdown }, cancelable: true }));
  if (isUnclaimed) quotesWaitingForTheirComposer.set(draftKey, joinParagraphs(quotesWaitingForTheirComposer.get(draftKey), markdown));
}

export const quoted = (text: string, thread: string, message: string) => `${text.trim().split("\n").map(l => `> ${l}`).join("\n")}\n>\n> — [[msg:${thread}/${message}]]`;

function quoteDetail(e: Event) {
  if (!(e instanceof CustomEvent)) return;
  const detail: unknown = e.detail;
  if (!isRecord(detail) || typeof detail["draftKey"] !== "string" || typeof detail["markdown"] !== "string") return;
  return { draftKey: detail["draftKey"], markdown: detail["markdown"] };
}

function focusAfterText(el: HTMLTextAreaElement | null) {
  el?.focus();
  el?.setSelectionRange(el.value.length, el.value.length);
}

export function useQuote(draftKey: string, inputRef: React.RefObject<HTMLTextAreaElement | null>) {
  const [quote, setQuote] = usePersistentDraft(`${draftKey}:quote`);
  const takeQuote = (markdown: string) => {
    setQuote(prev => joinParagraphs(prev, markdown));
    focusAfterText(inputRef.current);
    // constraint: the click that quoted (a menu closing, a selection clearing) can hand focus back a frame later, so focus is taken again
    requestAnimationFrame(() => focusAfterText(inputRef.current));
  };
  const latestTakeQuote = useLatest(takeQuote);
  useEventListener("composer-quote", e => {
    const detail = quoteDetail(e);
    if (detail?.draftKey !== draftKey) return;
    e.preventDefault();
    takeQuote(detail.markdown);
  });
  const attachInput = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inputRef.current = el;
      const pending = el ? quotesWaitingForTheirComposer.get(draftKey) : undefined;
      if (pending === undefined || pending === "") return;
      quotesWaitingForTheirComposer.delete(draftKey);
      latestTakeQuote.current(pending);
    },
    [draftKey, inputRef, latestTakeQuote],
  );
  return { quote, setQuote, attachInput };
}
