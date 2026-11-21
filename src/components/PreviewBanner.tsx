import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useInterval, useResource } from "@/lib/effects";
import { hasText } from "@/lib/utils";
import { isRecord } from "../../shared/guards";

type Verdict = "ship" | "changes" | "discard";
type Preview = { name: string; branch: string; what: string; tryThis: string; isHis: boolean; verdict?: { verdict: Verdict; note: string } };
const LABELS: Record<Verdict, string> = { ship: "Ship it", changes: "Needs changes", discard: "Discard" };
const SEEN_EVERY_MS = 60_000;

const isPreview = (value: unknown): value is Preview => isRecord(value) && typeof value["name"] === "string" && typeof value["branch"] === "string";

async function loadPreview(): Promise<Preview | null> {
  const res = await fetch("/api/preview");
  if (!res.ok) return null;
  const answer: unknown = await res.json();
  return isPreview(answer) ? answer : null;
}

function markSeenWhileHeLooks() {
  if (document.visibilityState === "visible") void fetch("/api/preview/seen", { method: "POST" });
}

function Verdicts({ preview }: { preview: Preview }) {
  const [sent, setSent] = useState<Verdict | undefined>(preview.verdict?.verdict);
  const [isWritingNote, setWritingNote] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const send = async (verdict: Verdict) => {
    const res = await fetch("/api/preview/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verdict, note }) });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    setSent(verdict);
    setWritingNote(false);
    setError(undefined);
  };
  const press = (verdict: Verdict) => () => {
    void send(verdict);
  };
  if (sent !== undefined && !isWritingNote)
    return (
      <span className="text-muted-foreground">
        Sent “{LABELS[sent]}” to the agent{sent === "changes" ? "; it posts a new preview when it has them." : ", and this preview stops now."}
        {sent === "changes" && (
          <Button size="xs" variant="link" onClick={() => setWritingNote(true)}>
            Add more
          </Button>
        )}
      </span>
    );
  if (!preview.isHis) return <span className="text-muted-foreground">Only Isaac’s browser gives the verdict.</span>;
  if (isWritingNote)
    return (
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={e => {
          e.preventDefault();
          void send("changes");
        }}
      >
        <input autoFocus value={note} onChange={e => setNote(e.target.value)} placeholder="What should change?" className="h-6 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" />
        <Button size="xs" type="submit" disabled={!hasText(note.trim())}>
          Send
        </Button>
        <Button size="xs" variant="ghost" type="button" onClick={() => setWritingNote(false)}>
          Cancel
        </Button>
        {error !== undefined && <span className="text-destructive">{error}</span>}
      </form>
    );
  return (
    <span className="flex items-center gap-1.5">
      <Button size="xs" onClick={press("ship")}>
        Ship it
      </Button>
      <Button size="xs" variant="outline" onClick={() => setWritingNote(true)}>
        Needs changes
      </Button>
      <Button size="xs" variant="ghost" onClick={press("discard")}>
        Discard
      </Button>
      {error !== undefined && <span className="text-destructive">{error}</span>}
    </span>
  );
}

function Banner({ preview }: { preview: Preview }) {
  useInterval(markSeenWhileHeLooks, SEEN_EVERY_MS);
  useEffect(() => {
    document.title = `Preview: ${preview.branch}`;
  }, [preview.branch]);
  return (
    <div data-agent="preview-banner" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs [app-region:no-drag]">
      <span className="flex items-center gap-1.5 font-semibold">
        <Eye className="size-3.5" />
        Preview of <code className="rounded bg-background/60 px-1">{preview.branch}</code>
      </span>
      <span className="min-w-0 flex-1 truncate" title={`What changed: ${preview.what}\nWhat to try: ${preview.tryThis}`}>
        {preview.what} <span className="text-muted-foreground">· Try: {preview.tryThis}</span>
      </span>
      <Verdicts preview={preview} />
    </div>
  );
}

export function PreviewBanner() {
  const preview = useResource("preview", loadPreview).value;
  return preview ? <Banner preview={preview} /> : null;
}
