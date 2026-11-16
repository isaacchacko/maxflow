import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn } from "@/lib/utils";
import { Markdown } from "./Rich";

/** The server keeps a pasted image as a file and returns its path, which the message carries as markdown for the agent to Read. */
async function upload(file: File) {
  const res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": file.type }, body: file });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { path } = (await res.json()) as { path: string };
  return path;
}

const preview = (path: string) => `/api/uploads/${path.split("/").at(-1)}`;

/** Adds a quote (markdown) to a composer's draft, ahead of what he types; the composer with that draft key takes it and focuses. */
export const quoteInto = (draftKey: string, markdown: string) => dispatchEvent(new CustomEvent("composer-quote", { detail: { draftKey, markdown } }));

const imagesIn = (files: FileList | undefined) => [...(files ?? [])].filter(f => f.type.startsWith("image/"));

/** A one-line message box that also takes images pasted from the clipboard or dropped on it: each is uploaded at once, and its path is kept with the draft so a reload keeps it attached. */
export function Composer({ onSend, className, autoFocus, agent, draftKey }: { onSend: (text: string) => unknown; className?: string; autoFocus?: boolean; agent: string; draftKey: string }) {
  const [draft, setDraft] = usePersistentDraft(draftKey);
  const [imageDraft, setImageDraft] = usePersistentDraft(`${draftKey}:images`);
  const images = imageDraft.split("\n").filter(Boolean);
  const setImages = (paths: string[]) => setImageDraft(paths.join("\n"));
  const [quote, setQuote] = usePersistentDraft(`${draftKey}:quote`);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onQuote = (e: Event) => {
      const { detail } = e as CustomEvent<{ draftKey: string; markdown: string }>;
      if (detail.draftKey !== draftKey) return;
      setQuote(prev => [prev, detail.markdown].filter(Boolean).join("\n\n"));
      input.current?.focus();
    };
    addEventListener("composer-quote", onQuote);
    return () => removeEventListener("composer-quote", onQuote);
  }, [draftKey]);
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
              <img src={preview(path)} alt="" className="h-20 max-w-40 border object-cover" />
              <button type="button" aria-label="Remove image" onClick={() => setImages(images.filter((_, m) => m !== n))} className="absolute top-0.5 right-0.5 bg-background/80 p-0.5 hover:bg-muted">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {uploading > 0 && <div className="flex h-20 w-20 items-center justify-center border text-xs text-muted-foreground">uploading…</div>}
        </div>
      )}
      {quote && (
        <div className="relative max-h-32 overflow-y-auto pr-6" data-agent={`${agent}-quote`}>
          <Markdown text={quote} className="text-xs" />
          <button type="button" aria-label="Remove quote" onClick={() => setQuote("")} className="absolute top-0 right-0 p-0.5 hover:bg-muted">
            <X className="size-3" />
          </button>
        </div>
      )}
      <input
        ref={input}
        autoFocus={autoFocus}
        data-agent={agent}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onPaste={e => {
          const files = imagesIn(e.clipboardData.files);
          if (files.length) e.preventDefault(), void attach(files);
        }}
        placeholder="Message"
        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
