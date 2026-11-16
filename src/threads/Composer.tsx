import { X } from "lucide-react";
import { useState } from "react";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn } from "@/lib/utils";

/** The server keeps a pasted image as a file and returns its path, which the message carries as markdown for the agent to Read. */
async function upload(file: File) {
  const res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": file.type }, body: file });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { path } = (await res.json()) as { path: string };
  return `![image](${path})`;
}

const imagesIn = (files: FileList | undefined) => [...(files ?? [])].filter(f => f.type.startsWith("image/"));

/** A one-line message box that also takes images pasted from the clipboard or dropped on it, previewed until sent. */
export function Composer({ onSend, className, autoFocus, agent, draftKey }: { onSend: (text: string) => unknown; className?: string; autoFocus?: boolean; agent: string; draftKey: string }) {
  const [draft, setDraft] = usePersistentDraft(draftKey);
  const [images, setImages] = useState<{ file: File; preview: string }[]>([]);
  const [error, setError] = useState("");

  function attach(files: File[]) {
    if (files.length) setImages(all => [...all, ...files.map(file => ({ file, preview: URL.createObjectURL(file) }))]);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() && !images.length) return;
    try {
      const marks = await Promise.all(images.map(i => upload(i.file)));
      onSend([draft.trim(), ...marks].filter(Boolean).join("\n"));
      setDraft("");
      images.forEach(i => URL.revokeObjectURL(i.preview));
      setImages([]);
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <form
      onSubmit={send}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        const files = imagesIn(e.dataTransfer.files);
        if (files.length) e.preventDefault(), attach(files);
      }}
      className={cn("flex flex-col gap-2", className)}
    >
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2" data-agent={`${agent}-images`}>
          {images.map((i, n) => (
            <div key={i.preview} className="relative">
              <img src={i.preview} alt="" className="h-20 max-w-40 border object-cover" />
              <button type="button" aria-label="Remove image" onClick={() => (URL.revokeObjectURL(i.preview), setImages(all => all.filter((_, m) => m !== n)))} className="absolute top-0.5 right-0.5 bg-background/80 p-0.5 hover:bg-muted">
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        autoFocus={autoFocus}
        data-agent={agent}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onPaste={e => {
          const files = imagesIn(e.clipboardData.files);
          if (files.length) e.preventDefault(), attach(files);
        }}
        placeholder="Message"
        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
