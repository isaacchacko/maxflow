import { useRef, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { CLICK_SLOP_PX, elementUnder, ONE_THING_A_CLICK, rectOf, type Rect } from "./region";

type Drag = { x0: number; y0: number; rect: Rect };

const dragRect = (d: Drag, x: number, y: number): Rect => ({ x: Math.min(d.x0, x), y: Math.min(d.y0, y), w: Math.abs(x - d.x0), h: Math.abs(y - d.y0) });

function DimmedOutside({ box }: { box: Rect | null }) {
  if (!box) return <div className="absolute inset-0 bg-black/45" />;
  return <div className="absolute rounded-md border-2 border-link shadow-[0_0_0_9999px_rgb(0_0_0/0.45)]" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />;
}

function useDrag() {
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  return { drag, dragRef, setDrag };
}

export function PickOverlay({ overlayRef, onPick }: { overlayRef: React.RefObject<HTMLDivElement | null>; onPick: (rect: Rect, picked?: Element) => void }) {
  const { drag, dragRef, setDrag } = useDrag();
  const [hover, setHover] = useState<Rect | null>(null);
  const frameRef = useRef(0);
  const thingUnder = (x: number, y: number) => elementUnder(x, y, overlayRef.current)?.closest(ONE_THING_A_CLICK);
  const hitTestNextFrame = (x: number, y: number) => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const snap = thingUnder(x, y);
      setHover(snap ? rectOf(snap) : null);
    });
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const r = dragRef.current?.rect;
    setDrag(null);
    if (r && (r.w > CLICK_SLOP_PX || r.h > CLICK_SLOP_PX)) {
      onPick(r);
      return;
    }
    const snap = thingUnder(e.clientX, e.clientY);
    if (snap) onPick(rectOf(snap), snap);
  };
  return (
    <div
      ref={overlayRef}
      data-agent="capture-overlay"
      className="pointer-events-auto fixed inset-0 z-[100] cursor-crosshair"
      onMouseDown={e => setDrag({ x0: e.clientX, y0: e.clientY, rect: { x: e.clientX, y: e.clientY, w: 0, h: 0 } })}
      onMouseMove={e => {
        const d = dragRef.current;
        if (d) setDrag({ ...d, rect: dragRect(d, e.clientX, e.clientY) });
        else hitTestNextFrame(e.clientX, e.clientY);
      }}
      onMouseUp={onMouseUp}
    >
      <DimmedOutside box={drag?.rect ?? hover} />
      <p className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-raised">
        Drag a region or click a message, card or row · <Kbd>esc</Kbd> cancels
      </p>
    </div>
  );
}

export type Shot = { rect: Rect; png?: Blob; preview?: string; context: string; target: HTMLElement };

function ShotPreview({ shot, error }: { shot: Shot | null; error: string }) {
  if (shot?.preview !== undefined) return <img src={shot.preview} alt="" className="max-h-64 self-start border object-contain" />;
  if (!shot || error !== "") return null;
  return (
    <div data-agent="capture-rendering" style={{ aspectRatio: `${shot.rect.w} / ${shot.rect.h}` }} className="flex max-h-64 w-full max-w-full animate-pulse items-center justify-center self-start border bg-muted text-xs text-muted-foreground">
      rendering…
    </div>
  );
}

function PopoverHint({ isSending, isWaitingForPicture }: { isSending: boolean; isWaitingForPicture: boolean }) {
  if (isSending) return "Sending…";
  if (isWaitingForPicture) return "Sends when the picture is ready…";
  return (
    <>
      Starts an inbox thread with the screenshot and where it was taken · <Kbd>↵</Kbd> send · <Kbd>esc</Kbd> cancel
    </>
  );
}

type PopoverProps = {
  shot: Shot | null;
  error: string;
  comment: string;
  onComment: (text: string) => void;
  isSending: boolean;
  isSendingWhenReady: boolean;
  onEnter: () => void;
  onCancel: () => void;
};

export function CommentPopover({ shot, error, comment, onComment, isSending, isSendingWhenReady, onEnter, onCancel }: PopoverProps) {
  return (
    <div
      data-capture-ui
      className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div data-agent="capture-popover" className="flex w-[min(36rem,calc(100%-2rem))] flex-col gap-2 rounded-2xl border bg-card p-3 shadow-lg">
        <ShotPreview shot={shot} error={error} />
        {error !== "" && <p className="text-xs text-destructive">{error}</p>}
        <input
          autoFocus
          data-agent="capture-comment"
          value={comment}
          disabled={isSending}
          onChange={e => onComment(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onEnter();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="Say what this is about, Enter sends it to the funnel"
          className="rounded-xl border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60"
        />
        <p className="text-[11px] text-muted-foreground">
          <PopoverHint isSending={isSending} isWaitingForPicture={shot?.png === undefined && isSendingWhenReady} />
        </p>
      </div>
    </div>
  );
}
