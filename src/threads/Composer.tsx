import { X } from "lucide-react";
import { useState } from "react";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn } from "@/lib/utils";

/** The server keeps a pasted image as a file and returns its path, which the message carries as markdown for the agent to Read. */
async function upload(file: File) {
  const res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": file.type }, body: file });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { path } = (await res.json()) as { path: string };
  return path;
}

const preview = (path: string) => `/api/uploads/${path.split("/").at(-1)}`;

const imagesIn = (files: FileList | undefined) => [...(files ?? [])].filter(f => f.type.startsWith("image/"));

/** A one-line message box that also takes images pasted from the clipboard or dropped on it: each is uploaded at once, and its path is kept with the draft so a reload keeps it attached. */
export function Composer({ onSend, className, autoFocus, agent, draftKey }: { onSend: (text: string) => unknown; className?: string; autoFocus?: boolean; agent: string; draftKey: string }) {
  const [draft, setDraft] = usePersistentDraft(draftKey);
  const [imageDraft, setImageDraft] = usePersistentDraft(`${draftKey}:images`);
  const images = imageDraft.split("\n").filter(Boolean);
  const setImages = (paths: string[]) => setImageDraft(paths.join("\n"));
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
    if (uploading || (!draft.trim() && !images.length)) return;
    onSend([draft.trim(), ...images.map(path => `![image](${path})`)].filter(Boolean).join("\n"));
    setDraft("");
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
      <input
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
