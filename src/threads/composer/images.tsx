import { X } from "lucide-react";
import { useState } from "react";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { isRecord } from "../../../shared/guards";

async function uploadKeptAsFile(file: File) {
  const res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": file.type }, body: file });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body["path"] !== "string") throw new Error("upload returned no path");
  return body["path"];
}

const preview = (path: string) => `/api/uploads/${path.split("/").at(-1)}`;

export const imagesIn = (files: FileList | null | undefined) => [...(files ?? [])].filter(f => f.type.startsWith("image/"));

const linesOf = (text: string) => text.split("\n").filter(Boolean);

export function useImageUploads(draftKey: string) {
  const [imageDraft, setImageDraft] = usePersistentDraft(`${draftKey}:images`);
  const images = linesOf(imageDraft);
  const setImages = (paths: string[]) => setImageDraft(paths.join("\n"));
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState("");
  async function attach(files: File[]) {
    if (files.length === 0) return;
    setUploading(n => n + files.length);
    try {
      const paths = await Promise.all(files.map(uploadKeptAsFile));
      setImageDraft(prev => [...linesOf(prev), ...paths].join("\n"));
      setError("");
    } catch (error_) {
      setError(String(error_));
    } finally {
      setUploading(n => n - files.length);
    }
  }
  return { images, setImages, uploading, error, setError, attach };
}

export function AttachedImages({ agent, images, uploading, onRemove }: { agent: string; images: string[]; uploading: number; onRemove: (index: number) => void }) {
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2" data-agent={`${agent}-images`}>
      {images.map((path, n) => (
        <div key={path} className="relative">
          <img src={preview(path)} alt="" className="h-20 max-w-40 rounded-lg border object-cover" />
          <button type="button" aria-label="Remove image" onClick={() => onRemove(n)} className="absolute top-1 right-1 rounded-full bg-card/90 p-0.5 hover:bg-muted">
            <X className="size-3" />
          </button>
        </div>
      ))}
      {uploading > 0 && <div className="flex h-20 w-20 items-center justify-center rounded-lg border text-xs text-muted-foreground">uploading…</div>}
    </div>
  );
}
