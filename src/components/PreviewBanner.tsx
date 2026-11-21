import { ExternalLink, Eye } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useEventListener, useInterval, useResource } from "@/lib/effects";
import { hasText } from "@/lib/utils";
import { isRecord } from "../../shared/guards";

type Verdict = "ship" | "changes" | "discard";
type Preview = { name: string; branch: string; what: string; tryThis: string };
type OnLive = Preview & { url: string; isHis: boolean; verdict?: { verdict: Verdict; note: string } };
type InPreview = Preview & { verdictPage: string };
const LABELS: Record<Verdict, string> = { ship: "Ship it", changes: "Needs changes", discard: "Discard" };
const SEEN_EVERY_MS = 60_000;

const isPreview = (value: unknown): value is Preview => isRecord(value) && typeof value["name"] === "string" && typeof value["branch"] === "string";
const isInPreview = (value: unknown): value is InPreview => isRecord(value) && typeof value["verdictPage"] === "string" && isPreview(value);
const isOnLive = (value: unknown): value is OnLive => isRecord(value) && typeof value["url"] === "string" && isPreview(value);

async function loadThisPreview(): Promise<InPreview | null> {
  const res = await fetch("/api/preview");
  if (!res.ok) return null;
  const answer: unknown = await res.json();
  if (!isInPreview(answer)) return null;
  document.title = `Preview: ${answer.branch}`;
  return answer;
}

async function loadPreviewOnLive(name: string): Promise<OnLive | null> {
  const res = await fetch(`/api/previews/${name}`);
  if (!res.ok) return null;
  const answer: unknown = await res.json();
  return isOnLive(answer) ? answer : null;
}

const previewInHash = () => /^#preview\/(pv-[\w-]+)$/.exec(location.hash)?.[1];

function markSeenWhileHeLooks() {
  if (document.visibilityState === "visible") void fetch("/api/preview/seen", { method: "POST" });
}

function Verdicts({ preview }: { preview: OnLive }) {
  const [sent, setSent] = useState<Verdict | undefined>(preview.verdict?.verdict);
  const [isWritingNote, setWritingNote] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const send = async (verdict: Verdict) => {
    const res = await fetch(`/api/previews/${preview.name}/verdict`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verdict, note }) });
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

function Strip({ preview, children }: { preview: Preview; children: React.ReactNode }) {
  return (
    <div data-agent="preview-banner" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs [app-region:no-drag]">
      <span className="flex items-center gap-1.5 font-semibold">
        <Eye className="size-3.5" />
        Preview of <code className="rounded bg-background/60 px-1">{preview.branch}</code>
      </span>
      <span className="min-w-0 flex-1 truncate" title={`What changed: ${preview.what}\nWhat to try: ${preview.tryThis}`}>
        {preview.what} <span className="text-muted-foreground">· Try: {preview.tryThis}</span>
      </span>
      {children}
    </div>
  );
}

function InThePreview({ preview }: { preview: InPreview }) {
  useInterval(markSeenWhileHeLooks, SEEN_EVERY_MS);
  return (
    <Strip preview={preview}>
      <a href={preview.verdictPage} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-medium underline-offset-4 hover:underline">
        Give your verdict in yarn <ExternalLink className="size-3" />
      </a>
    </Strip>
  );
}

function VerdictOnLive({ name }: { name: string }) {
  const preview = useResource(`preview/${name}`, async () => loadPreviewOnLive(name)).value;
  if (!preview) return null;
  return (
    <Strip preview={preview}>
      <a href={preview.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 underline-offset-4 hover:underline">
        Open the preview <ExternalLink className="size-3" />
      </a>
      <Verdicts preview={preview} />
    </Strip>
  );
}

export function PreviewBanner() {
  const thisPreview = useResource("preview", loadThisPreview).value;
  const [asked, setAsked] = useState(previewInHash);
  useEventListener("hashchange", () => setAsked(previewInHash()));
  if (thisPreview) return <InThePreview preview={thisPreview} />;
  return asked === undefined ? null : <VerdictOnLive key={asked} name={asked} />;
}
