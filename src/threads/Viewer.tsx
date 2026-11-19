import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { createContext, memo, useState } from "react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { createStore } from "@/store";
import { when } from "./MessageRow";
import { Author, Avatar, uploadsIn } from "./Rich";
import { useZoom } from "./viewer-zoom";

export type Shot = { url: string; from: string; at: string };

export const shotsOf = (messages: Thread["messages"]): Shot[] => messages.flatMap(m => uploadsIn(m.text).map(url => ({ url, from: m.from, at: m.at })));

export const ShotScope = createContext<Shot[] | undefined>(undefined);

type Viewing = { shots: Shot[]; at: number };
const viewing = createStore<Viewing | undefined>(undefined);
export const openViewer = (shots: Shot[], url: string) => viewing.set({ shots, at: Math.max(0, shots.findIndex(s => s.url === url)) });
const closeViewer = () => viewing.set(undefined);

function ViewerHeader({ shot, at, n }: { shot: Shot; at: number; n: number }) {
  return (
    <header className="flex items-center gap-2.5 px-4 py-2.5">
      <Avatar from={shot.from} />
      <div className="min-w-0 flex-1">
        <Dialog.Title className="text-sm">
          <Author from={shot.from} />
        </Dialog.Title>
        <p className="text-xs text-white/60 tabular-nums">
          {when(shot.at)} · {at + 1} of {n}
        </p>
      </div>
      <a href={shot.url} download data-agent="viewer-download" title="Download" className="p-2 text-white/70 hover:text-white">
        <Download className="size-4" />
      </a>
      <a href={shot.url} target="_blank" rel="noreferrer" data-agent="viewer-original" title="Open the original" className="p-2 text-white/70 hover:text-white">
        <ExternalLink className="size-4" />
      </a>
      <Dialog.Close data-agent="viewer-close" title="Close (Esc)" className="p-2 text-white/70 hover:text-white">
        <X className="size-4" />
      </Dialog.Close>
    </header>
  );
}

type Loaded = { url: string | undefined; set: (url: string) => void };

function useViewerKeys(open: Viewing, zoomBy: (k: number, px?: number, py?: number, isEased?: boolean) => void, reset: (isEased?: boolean) => void) {
  const n = open.shots.length;
  const go = (by: number) => viewing.set({ ...open, at: (open.at + by + n) % n });
  const keys: Record<string, () => void> = {
    ArrowLeft: () => go(-1),
    h: () => go(-1),
    ArrowRight: () => go(1),
    l: () => go(1),
    "+": () => zoomBy(1.25, 0, 0, true),
    "=": () => zoomBy(1.25, 0, 0, true),
    "-": () => zoomBy(0.8, 0, 0, true),
    "0": () => reset(true),
  };
  const onKey = (e: React.KeyboardEvent) => {
    const action = keys[e.key];
    e.stopPropagation();
    if (!action || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    action();
  };
  return { go, onKey };
}

function ViewerContent({ open, shot, loaded }: { open: Viewing; shot: Shot; loaded: Loaded }) {
  const { attachStage, attachImg, onStageClick, startDrag, moveDrag, endDrag, toggleAt, zoomBy, reset, isZoomed } = useZoom();
  const { go, onKey } = useViewerKeys(open, zoomBy, reset);
  const n = open.shots.length;
  const showOnceDecoded = async (img: HTMLImageElement, url: string) => {
    try {
      await img.decode();
    } catch {
      // constraint: decode() rejects for some images that still draw, and those show anyway
    }
    loaded.set(url);
  };
  return (
    <Dialog.Content data-agent="viewer" aria-describedby={undefined} onKeyDown={onKey} onEscapeKeyDown={e => e.stopPropagation()} className="fixed inset-0 z-50 flex flex-col text-white outline-none select-none">
      <ViewerHeader shot={shot} at={open.at} n={n} />
      <div
        ref={attachStage}
        data-agent="viewer-stage"
        onClick={e => onStageClick(e, closeViewer)}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-14"
      >
        {loaded.url !== shot.url && <span className="absolute text-xs text-white/50">loading…</span>}
        <img
          key={`${open.at}:${shot.url}`}
          ref={attachImg}
          src={shot.url}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={e => {
            void showOnceDecoded(e.currentTarget, shot.url);
          }}
          className={cn("max-h-full max-w-full object-contain", isZoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in", loaded.url !== shot.url && "opacity-0")}
          onDoubleClick={e => toggleAt(e.clientX, e.clientY)}
        />
        {n > 1 && (
          <>
            <button data-agent="viewer-prev" title="Previous (←)" onClick={() => go(-1)} className="absolute left-3 bg-black/50 p-2 text-white/70 hover:text-white">
              <ChevronLeft className="size-5" />
            </button>
            <button data-agent="viewer-next" title="Next (→)" onClick={() => go(1)} className="absolute right-3 bg-black/50 p-2 text-white/70 hover:text-white">
              <ChevronRight className="size-5" />
            </button>
          </>
        )}
      </div>
      {n > 1 && <Strip shots={open.shots} at={open.at} />}
    </Dialog.Content>
  );
}

export function Viewer() {
  const open = viewing.use();
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const shot = open?.shots[open.at];
  return (
    <Dialog.Root open={Boolean(shot)} onOpenChange={o => o || closeViewer()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/95" />
        {open && shot && <ViewerContent open={open} shot={shot} loaded={{ url: loadedUrl, set: setLoadedUrl }} />}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const Strip = memo(function Thumbnails({ shots, at }: { shots: Shot[]; at: number }) {
  return (
    <nav data-agent="viewer-strip" className="flex justify-center gap-1.5 overflow-x-auto px-4 py-3">
      {shots.map((s, i) => (
        <button key={i} onClick={() => viewing.set({ shots, at: i })} className={cn("shrink-0 border-2", i === at ? "border-sky-400" : "border-transparent opacity-50 hover:opacity-100")}>
          <img src={s.url} alt="" loading="lazy" decoding="async" draggable={false} className="h-12 w-16 object-cover" />
        </button>
      ))}
    </nav>
  );
});
