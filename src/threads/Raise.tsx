import { ArrowUpToLine } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRef, useState } from "react";
import { hasText } from "@/lib/utils";
import type { Thread } from "@/mock";
import { createStore, startThread } from "@/store";
import { quoted } from "./Composer";
import { Markdown } from "./Rich";

type Raising = { thread: string; message: string; text: string };
const raising = createStore<Raising | undefined>(undefined);

export const openRaise = (thread: string, message: string, text: string) => raising.set({ thread, message, text });

export const raisedText = (comment: string, quote: string) => [comment.trim(), quote].filter(Boolean).join("\n\n");

export const raise = async (text: string) => {
  await startThread(text);
};

export const raisedTo = (threads: Thread[], thread: string, message: string) => {
  const chip = `[[msg:${thread}/${message}]]`;
  return threads.filter(t => !hasText(t.parentId) && t.id !== thread && t.messages[0]?.text.includes(chip) === true);
};

export function RaiseDialog() {
  const r = raising.use();
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const [emptyBoxFor, setEmptyBoxFor] = useState(r);
  if (emptyBoxFor !== r) {
    setEmptyBoxFor(r);
    setComment("");
    setSending(false);
  }
  const close = () => raising.set(undefined);
  const quote = r ? quoted(r.text, r.thread, r.message) : "";
  const send = async () => {
    if (!r || sending) return;
    setSending(true);
    await raise(raisedText(comment, quote));
    close();
  };
  return (
    <Dialog.Root open={Boolean(r)} onOpenChange={o => o || close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
        <Dialog.Content
          data-agent="raise"
          aria-describedby={undefined}
          onKeyDown={e => e.stopPropagation()}
          onEscapeKeyDown={e => e.stopPropagation()}
          onOpenAutoFocus={e => {
            e.preventDefault();
            box.current?.focus();
          }}
          onCloseAutoFocus={e => e.preventDefault()}
          className="fixed top-[18%] left-1/2 z-50 flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-3 rounded-2xl border bg-card p-4 shadow-raised outline-none"
        >
          <Dialog.Title className="flex items-center gap-2 text-sm font-medium">
            <ArrowUpToLine className="size-4 text-muted-foreground" />
            Raise to Threads
          </Dialog.Title>
          <form
            onSubmit={e => {
              e.preventDefault();
              void send();
            }}
            className="flex flex-col gap-3"
          >
            <textarea
              ref={box}
              data-agent="raise-input"
              value={comment}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => {
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                void send();
              }}
              rows={3}
              placeholder="Say something about it…"
              className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            />
            <div className="max-h-48 overflow-y-auto rounded-lg border-l-2 border-border bg-muted/40 px-3 py-2">
              <Markdown text={r?.text ?? ""} className="text-sm text-muted-foreground" />
            </div>
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-xs text-muted-foreground">A new thread in Threads, routed like anything you write there</span>
              <button type="button" onClick={close} className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted">
                Cancel
              </button>
              <button type="submit" data-agent="raise-send" disabled={sending} className="rounded-lg bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50">
                Raise
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
