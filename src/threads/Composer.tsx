import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn } from "@/lib/utils";
import { useMentionPicker } from "./Mention";
import { Markdown } from "./Rich";

/** The server keeps a pasted image as a file and returns its path, which the message carries as markdown for the agent to Read. */
async function upload(file: File) {
  const res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": file.type }, body: file });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { path } = (await res.json()) as { path: string };
  return path;
}

const preview = (path: string) => `/api/uploads/${path.split("/").at(-1)}`;

/**
 * Adds a quote (markdown) to a composer's draft, ahead of what he types; the composer with that draft key takes it and focuses.
 * With no such composer drawn yet (a subthread still opening), the quote waits for it.
 */
const waiting = new Map<string, string>();
export function quoteInto(draftKey: string, markdown: string) {
  if (dispatchEvent(new CustomEvent("composer-quote", { detail: { draftKey, markdown }, cancelable: true }))) waiting.set(draftKey, [waiting.get(draftKey), markdown].filter(Boolean).join("\n\n"));
}

const imagesIn = (files: FileList | undefined) => [...(files ?? [])].filter(f => f.type.startsWith("image/"));

/** A message box that wraps and grows with its text, and takes images pasted from the clipboard or dropped on it: each is uploaded at once, and its path is kept with the draft so a reload keeps it attached. */
// tools: small buttons drawn at the box's right, such as the thread's subthread nudge.
export function Composer({ onSend, className, autoFocus, agent, draftKey, tools }: { onSend: (text: string) => unknown; className?: string; autoFocus?: boolean; agent: string; draftKey: string; tools?: React.ReactNode }) {
  const [draft, setDraft] = usePersistentDraft(draftKey);
  const [imageDraft, setImageDraft] = usePersistentDraft(`${draftKey}:images`);
  const images = imageDraft.split("\n").filter(Boolean);
  const setImages = (paths: string[]) => setImageDraft(paths.join("\n"));
  const [quote, setQuote] = usePersistentDraft(`${draftKey}:quote`);
  const input = useRef<HTMLTextAreaElement>(null);
  // It grows with what he types, up to 40% of the window, then scrolls.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, innerHeight * 0.4)}px`;
  }, [draft]);
  useEffect(() => {
    // Quoted, he types next: the box takes focus with the caret after his text, and takes it again a frame later in case the
    // click that quoted (a menu closing, a selection clearing) hands focus back to where it came from.
    const take = (markdown: string) => {
      setQuote(prev => [prev, markdown].filter(Boolean).join("\n\n"));
      const focusEnd = () => {
        const el = input.current;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
      };
      focusEnd();
      requestAnimationFrame(focusEnd);
    };
    const onQuote = (e: Event) => {
      const { detail } = e as CustomEvent<{ draftKey: string; markdown: string }>;
      if (detail.draftKey !== draftKey) return;
      e.preventDefault();
      take(detail.markdown);
    };
    const pending = waiting.get(draftKey);
    if (pending) waiting.delete(draftKey), take(pending);
    addEventListener("composer-quote", onQuote);
    return () => removeEventListener("composer-quote", onQuote);
  }, [draftKey]);
  const mention = useMentionPicker(input, draft, setDraft, draftKey.match(/^thread:([\w-]+)$/)?.[1]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState("");

  async function attach(files: File[]) {
    if (!files.length) return;
    setUploading(n => n + files.length);
    try {
      const paths = await Promise.all(files.map(upload));
      setImageDraft(prev => [...prev.split("\n").filter(Boolean), ...paths].join("\n"));
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(n => n - files.length);
    }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    if (uploading || (!draft.trim() && !images.length && !quote)) return;
    onSend([quote && `${quote}\n`, draft.trim(), ...images.map(path => `![image](${path})`)].filter(Boolean).join("\n"));
    setDraft("");
    setQuote("");
    setImages([]);
    setError("");
  }

  return (
    <form
      onSubmit={send}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        const files = imagesIn(e.dataTransfer.files);
        if (files.length) e.preventDefault(), void attach(files);
      }}
      className={cn("flex flex-col gap-2", className)}
    >
      {(images.length > 0 || uploading > 0) && (
        <div className="flex flex-wrap gap-2" data-agent={`${agent}-images`}>
          {images.map((path, n) => (
            <div key={path} className="relative">
              <img src={preview(path)} alt="" className="h-20 max-w-40 rounded-lg border object-cover" />
              <button type="button" aria-label="Remove image" onClick={() => setImages(images.filter((_, m) => m !== n))} className="absolute top-1 right-1 rounded-full bg-card/90 p-0.5 hover:bg-muted">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {uploading > 0 && <div className="flex h-20 w-20 items-center justify-center rounded-lg border text-xs text-muted-foreground">uploading…</div>}
        </div>
      )}
      {quote && (
        <div className="relative max-h-32 overflow-y-auto pr-6" data-agent={`${agent}-quote`}>
          <Markdown text={quote} className="text-xs" />
          <button type="button" aria-label="Remove quote" onClick={() => setQuote("")} className="absolute top-0 right-0 rounded-md p-0.5 hover:bg-muted">
            <X className="size-3" />
          </button>
        </div>
      )}
      <div className="relative flex items-start gap-2">
      <textarea
        ref={input}
        rows={1}
        autoFocus={autoFocus}
        data-agent={agent}
        value={draft}
        onChange={e => (setDraft(e.target.value), mention.track())}
        onSelect={mention.track}
        // The @ picker takes its keys first while it is open. Enter sends, Shift+Enter is a new line; Enter that confirms an IME composition is neither. Escape in an empty box
        // leaves it, back to the keys that move through the page.
        onKeyDown={e => {
          if (mention.onKeyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) e.preventDefault(), e.currentTarget.form?.requestSubmit();
          else if (e.key === "Escape" && !draft) e.currentTarget.blur();
        }}
        onPaste={e => {
          const files = imagesIn(e.clipboardData.files);
          if (files.length) e.preventDefault(), void attach(files);
        }}
        placeholder="Message"
        className="w-full resize-none overflow-y-auto bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60"
      />
      {tools}
      {mention.panel}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
