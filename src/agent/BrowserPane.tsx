import { useCallback, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type SubmitEvent } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { FitRow } from "@/components/Fit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Segmented } from "@/views/stats/parts";
import { isRecord } from "../../shared/guards";
import { keyAsk, mouseAsk, wheelAsk, type InputAsk } from "./browser-input";

type Page = { url: string; title: string; isHeld: boolean; problem?: string | undefined };
type Ask = InputAsk | { type: "goto"; url: string } | { type: "back" | "forward" | "reload" } | { type: "hold"; isTaking: boolean };

const MOVE_EVERY_MS = 33;
const MODES = [
  { id: "watch", label: "Watch" },
  { id: "drive", label: "Take over" },
] as const;

function pageFrom(text: string, shown: Page): Page {
  const said: unknown = JSON.parse(text);
  if (!isRecord(said)) return shown;
  if (said["type"] === "error") return { ...shown, problem: String(said["message"]) };
  if (said["type"] === "held") return { ...shown, isHeld: said["isHeld"] === true };
  return { ...shown, url: String(said["url"]), title: String(said["title"]), problem: undefined };
}

function useScreencast(id: string) {
  const [page, setPage] = useState<Page>({ url: "", title: "", isHeld: false });
  const socket = useRef<WebSocket | null>(null);
  const mount = useCallback(
    (element: HTMLImageElement) => {
      const ws = new WebSocket(`ws://${location.host}/ws/browser/${id}`);
      ws.binaryType = "arraybuffer";
      let frame = "";
      ws.addEventListener("message", (e: MessageEvent<unknown>) => {
        if (typeof e.data === "string") {
          const text = e.data;
          setPage(shown => pageFrom(text, shown));
          return;
        }
        if (!(e.data instanceof ArrayBuffer)) return;
        const next = URL.createObjectURL(new Blob([e.data], { type: "image/jpeg" }));
        element.src = next;
        if (frame !== "") URL.revokeObjectURL(frame);
        frame = next;
      });
      socket.current = ws;
      return () => {
        ws.close();
        if (frame !== "") URL.revokeObjectURL(frame);
      };
    },
    [id],
  );
  const ask = (asked: Ask) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(asked));
  };
  return { page, mount, ask };
}

function UrlBar({ url, onGo }: { url: string; onGo: (url: string) => void }) {
  const [draft, setDraft] = useState<string>();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (draft !== undefined && draft.trim() !== "") onGo(draft.trim());
    setDraft(undefined);
  };
  return (
    <form onSubmit={submit} className="min-w-24 flex-1">
      <input
        aria-label="Address"
        value={draft ?? url}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => setDraft(undefined)}
        spellCheck={false}
        className="h-8 w-full rounded-md border bg-background px-2.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </form>
  );
}

function useDriving(isHeld: boolean, ask: (asked: Ask) => void) {
  const lastMoveAt = useRef(0);
  const mouse = (e: MouseEvent<HTMLImageElement>) => {
    if (!isHeld) return;
    e.preventDefault();
    if (e.type === "mousemove") {
      if (e.timeStamp - lastMoveAt.current < MOVE_EVERY_MS) return;
      lastMoveAt.current = e.timeStamp;
    }
    const asked = mouseAsk(e);
    if (asked) ask(asked);
  };
  const key = (e: KeyboardEvent) => {
    if (!isHeld || (e.target as HTMLElement).closest("form") !== null) return;
    e.preventDefault();
    ask(keyAsk(e));
  };
  const paste = (e: ClipboardEvent) => {
    if (!isHeld) return;
    e.preventDefault();
    ask({ type: "text", text: e.clipboardData.getData("text/plain") });
  };
  return { mouse, key, paste };
}

function Screen({ page, mount, ask }: ReturnType<typeof useScreencast>) {
  const { mouse, key, paste } = useDriving(page.isHeld, ask);
  return (
    <div
      tabIndex={page.isHeld ? 0 : -1}
      onKeyDown={key}
      onKeyUp={key}
      onPaste={paste}
      className={cn("flex min-h-0 flex-1 items-start justify-center bg-muted/40 outline-none", page.isHeld && "ring-2 ring-agent ring-inset")}
    >
      <img
        ref={mount}
        alt={page.title === "" ? "The agent's browser" : page.title}
        draggable={false}
        onMouseDown={e => {
          e.currentTarget.parentElement?.focus();
          mouse(e);
        }}
        onMouseUp={mouse}
        onMouseMove={mouse}
        onContextMenu={e => page.isHeld && e.preventDefault()}
        onWheel={e => page.isHeld && ask(wheelAsk(e))}
        className={cn("max-h-full max-w-full object-contain select-none", page.isHeld && "cursor-default")}
      />
    </div>
  );
}

export function BrowserPane({ id }: { id: string }) {
  const cast = useScreencast(id);
  const { page, ask } = cast;
  return (
    <section className="viz flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background" data-agent="browser">
      <FitRow className="h-11 shrink-0 items-center gap-1 border-b px-1.5">
        <Button variant="ghost" size="icon" title="Back" onClick={() => ask({ type: "back" })}>
          <ArrowLeft />
        </Button>
        <Button variant="ghost" size="icon" title="Forward" onClick={() => ask({ type: "forward" })}>
          <ArrowRight />
        </Button>
        <Button variant="ghost" size="icon" title="Reload" onClick={() => ask({ type: "reload" })}>
          <RotateCw />
        </Button>
        <UrlBar url={page.url} onGo={url => ask({ type: "goto", url })} />
        <Segmented label="Who drives the browser" options={[...MODES]} value={page.isHeld ? "drive" : "watch"} onChange={mode => ask({ type: "hold", isTaking: mode === "drive" })} />
      </FitRow>
      {page.problem !== undefined && <p className="border-b px-3 py-1.5 text-xs text-destructive">{page.problem}</p>}
      <Screen {...cast} />
    </section>
  );
}
