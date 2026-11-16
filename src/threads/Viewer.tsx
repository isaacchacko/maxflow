import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { createContext, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { createStore } from "@/store";
import { when } from "./MessageRow";
import { Author, Avatar, uploadsIn } from "./Rich";

/** One image in a thread, with who posted it and when, for the viewer's top bar. */
export type Shot = { url: string; from: string; at: string };

/** Every image in these messages, in order: what ←/→ walk through once one is open. */
export const shotsOf = (messages: Thread["messages"]): Shot[] => messages.flatMap(m => uploadsIn(m.text).map(url => ({ url, from: m.from, at: m.at })));

/** The images a clicked one belongs to: a thread page's messages, or an inbox row's thread. Outside a scope an image opens in a tab. */
export const ShotScope = createContext<Shot[] | undefined>(undefined);

const viewing = createStore<{ shots: Shot[]; at: number } | undefined>(undefined);
export const openViewer = (shots: Shot[], url: string) => viewing.set({ shots, at: Math.max(0, shots.findIndex(s => s.url === url)) });

const MIN = 1, MAX = 8;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

/**
 * Slack's attachment viewer: one image fit to the window over a dark scrim, its sender and "n of N" on top, a filmstrip below.
 * ←/→ or h/l move, +/-, the wheel or a pinch zoom toward the pointer, a drag pans once zoomed, 0 resets, Esc or a click outside closes.
 * It is a dialog, so the vim keys stand down while it is open, and it takes focus from the composer.
 */
export function Viewer() {
  const open = viewing.use();
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const [loaded, setLoaded] = useState<string>();
  // State, not a ref: the dialog mounts its content after the first effects run, and the wheel listener waits for it.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  // A drag's pointer capture lands its click on the scrim, which mustn't close: `moved` marks the click as the drag's.
  const drag = useRef<{ x: number; y: number; moved?: boolean } | null>(null);
  const shot = open?.shots[open.at];
  const n = open?.shots.length ?? 0;

  useEffect(() => setZoom({ s: 1, x: 0, y: 0 }), [shot?.url, open?.at]);

  // Zoom keeps the point under the pointer (or the middle, from the keys) where it is.
  const zoomBy = (k: number, px = 0, py = 0) =>
    setZoom(z => {
      const s = clamp(z.s * k);
      if (s === 1) return { s, x: 0, y: 0 };
      const r = s / z.s;
      return { s, x: px - (px - z.x) * r, y: py - (py - z.y) * r };
    });

  // The wheel is passive in React, and a pinch arrives as a ctrl-wheel that would zoom the whole page.
  useEffect(() => {
    const el = stage;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stage]);

  const go = (by: number) => open && viewing.set({ ...open, at: (open.at + by + n) % n });
  const onKey = (e: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => go(-1),
      h: () => go(-1),
      ArrowRight: () => go(1),
      l: () => go(1),
      "+": () => zoomBy(1.25),
      "=": () => zoomBy(1.25),
      "-": () => zoomBy(0.8),
      "0": () => setZoom({ s: 1, x: 0, y: 0 }),
    };
    // Every key is the viewer's while it is open: none reach the page's own (the views' digits, Escape's climb).
    e.stopPropagation();
    if (keys[e.key] && !e.metaKey && !e.ctrlKey) e.preventDefault(), keys[e.key]!();
  };

  return (
    <Dialog.Root open={!!shot} onOpenChange={o => o || viewing.set(undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/95" />
        <Dialog.Content
          data-agent="viewer"
          aria-describedby={undefined}
          onKeyDown={onKey}
          onEscapeKeyDown={e => e.stopPropagation()}
          className="fixed inset-0 z-50 flex flex-col text-white outline-none select-none"
        >
          {shot && (
            <>
              <header className="flex items-center gap-2.5 px-4 py-2.5">
                <Avatar from={shot.from} />
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-sm">
                    <Author from={shot.from} />
                  </Dialog.Title>
                  <p className="text-xs text-white/60 tabular-nums">
                    {when(shot.at)} · {open!.at + 1} of {n}
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
              {/* A click on the scrim around the image closes; on the image it doesn't. */}
              <div
                ref={setStage}
                data-agent="viewer-stage"
                onClick={e => (drag.current?.moved ? (drag.current = null) : e.target === e.currentTarget && viewing.set(undefined))}
                onPointerDown={e => zoom.s > 1 && e.target !== e.currentTarget && ((drag.current = { x: e.clientX - zoom.x, y: e.clientY - zoom.y }), e.currentTarget.setPointerCapture(e.pointerId))}
                onPointerMove={e => {
                  const d = drag.current;
                  if (d && e.buttons) (d.moved = true), setZoom(z => ({ ...z, x: e.clientX - d.x, y: e.clientY - d.y }));
                }}
                onPointerUp={() => drag.current?.moved || (drag.current = null)}
                className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-14"
              >
                {loaded !== shot.url && <span className="absolute text-xs text-white/50">loading…</span>}
                <img
                  key={shot.url}
                  src={shot.url}
                  alt=""
                  draggable={false}
                  onLoad={() => setLoaded(shot.url)}
                  style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` }}
                  className={cn("max-h-full max-w-full object-contain", zoom.s > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in", loaded !== shot.url && "opacity-0")}
                  onDoubleClick={e => {
                    const r = stage!.getBoundingClientRect();
                    zoom.s > 1 ? setZoom({ s: 1, x: 0, y: 0 }) : zoomBy(2.5, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
                  }}
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
              {n > 1 && (
                <nav data-agent="viewer-strip" className="flex justify-center gap-1.5 overflow-x-auto px-4 py-3">
                  {open!.shots.map((s, i) => (
                    <button key={i} onClick={() => viewing.set({ ...open!, at: i })} className={cn("shrink-0 border-2", i === open!.at ? "border-sky-400" : "border-transparent opacity-50 hover:opacity-100")}>
                      <img src={s.url} alt="" loading="lazy" draggable={false} className="h-12 w-16 object-cover" />
                    </button>
                  ))}
                </nav>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
