import { Maximize, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { useEventListener } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { type Camera, fitting, useCamera } from "./camera";
import { type CanvasNode, linkBox } from "./canvas-api";
import { messageOf, useBoxes, useEditing } from "./canvas-boxes";
import { Box, type BoxActions, BoxContext, LinkOffer, type Selected } from "./CanvasBox";

const FLASH_MS = 1400;
const CLICK_SLOP_PX = 4;
const GRID_PX = 24;
const NEW_BOX_OFFSET = { x: 20, y: 14 };

const short = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

function Controls({ zoom, onZoom, onFit }: { zoom: number; onZoom: (factor: number) => void; onFit: () => void }) {
  const button = "rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground";
  return (
    <div onPointerDown={(e) => e.stopPropagation()} className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border bg-card px-1 py-0.5 shadow-sm">
      <button type="button" title="Zoom out" onClick={() => onZoom(1 / 1.25)} className={button}>
        <Minus className="size-3.5" />
      </button>
      <span className="w-10 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
      <button type="button" title="Zoom in" onClick={() => onZoom(1.25)} className={button}>
        <Plus className="size-3.5" />
      </button>
      <button type="button" title="Fit every box" data-agent="canvas:fit" onClick={onFit} className={button}>
        <Maximize className="size-3.5" />
      </button>
    </div>
  );
}

type PlaneGesture = { pan: (dx: number, dy: number) => void; click: (at: { x: number; y: number }) => Promise<void> };

function pressPlane(e: React.PointerEvent<HTMLDivElement>, camera: Camera, on: PlaneGesture) {
  const el = e.currentTarget;
  const start = { x: e.clientX, y: e.clientY };
  let last = start;
  let hasMoved = false;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    hasMoved ||= Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > CLICK_SLOP_PX;
    if (hasMoved) on.pan(ev.clientX - last.x, ev.clientY - last.y);
    last = { x: ev.clientX, y: ev.clientY };
  };
  const up = (ev: PointerEvent) => {
    el.removeEventListener("pointermove", move);
    if (hasMoved) return;
    const r = el.getBoundingClientRect();
    void on.click({ x: Math.round((ev.clientX - r.left - camera.x) / camera.z), y: Math.round((ev.clientY - r.top - camera.y) / camera.z) });
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up, { once: true });
}

function useLinking(path: string, boxes: ReturnType<typeof useBoxes>, flush: (id: string) => void) {
  const [offer, setOffer] = useState<{ selected: Selected; at: DOMRect } | undefined>();
  const [picking, setPicking] = useState<Selected | undefined>();
  const cancel = () => {
    setPicking(undefined);
    setOffer(undefined);
  };
  useEventListener("keydown", (e) => {
    if (e.key === "Escape") cancel();
  });
  return {
    offer,
    picking,
    cancel,
    offerLink: (selected: Selected | undefined, at?: DOMRect) => setOffer(selected && at && !picking ? { selected, at } : undefined),
    startLink: (selected: Selected) => {
      setOffer(undefined);
      setPicking(selected);
    },
    pick: (to: string) => {
      setPicking(undefined);
      if (!picking || picking.from === to) return;
      const { from, text, near } = picking;
      flush(from);
      void boxes.inTurn(from, async () => boxes.upsert(await linkBox(path, from, { text, to, near })));
    },
  };
}

function useFlash() {
  const [flash, setFlash] = useState<string | undefined>();
  const show = (id: string) => {
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? undefined : f)), FLASH_MS);
  };
  return { flash, show };
}

function Header({ path, nodes, error, onDismiss }: { path: string; nodes: CanvasNode[] | undefined; error: string | undefined; onDismiss: () => void }) {
  return (
    <header className="flex items-center gap-2 border-b px-6 py-2.5">
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{path}</span>
      <span className="flex-1" />
      {hasText(error) && (
        <button type="button" title="Dismiss" onClick={onDismiss} className="truncate text-xs text-destructive">
          {error}
        </button>
      )}
      <span className="text-xs text-muted-foreground">{nodes ? `${nodes.length} box${nodes.length === 1 ? "" : "es"}` : "Loading…"}</span>
    </header>
  );
}

function Hints({ picking, isEmpty }: { picking: Selected | undefined; isEmpty: boolean }) {
  return (
    <>
      {picking && (
        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-amber-400 px-3 py-1 text-xs font-medium text-black shadow-md">
          Now click the box “{short(picking.text)}” should link to · Esc cancels
        </div>
      )}
      {isEmpty && <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm text-muted-foreground">Click anywhere to add a box</p>}
      <p className="pointer-events-none absolute bottom-3 left-3 text-[11px] text-muted-foreground/80">Click to add · drag to pan · pinch or ⌘-scroll to zoom · double-click to edit · select text to link</p>
    </>
  );
}

function useCanvas(path: string, plane: HTMLDivElement | null) {
  const [error, setError] = useState<string | undefined>();
  const view = useCamera(plane);
  const boxes = useBoxes(path, setError);
  const editor = useEditing(path, boxes);
  const linking = useLinking(path, boxes, editor.flush);
  const { flash, show } = useFlash();
  const { nodes } = boxes;
  const fit = () => {
    if (plane && nodes) view.setCamera(fitting(nodes, plane.clientWidth, plane.clientHeight));
  };
  if (!view.isPlaced && plane && nodes) fit();
  const actions: BoxActions = {
    ...editor,
    ...linking,
    path,
    zoom: view.camera.z,
    isPicking: linking.picking !== undefined,
    hasBox: (id) => nodes?.some((n) => n.id === id) === true,
    edit: (id) => {
      linking.cancel();
      editor.edit(id);
    },
    jump: (id) => {
      const target = nodes?.find((n) => n.id === id);
      if (!target) return;
      view.centerOn(target);
      show(id);
    },
  };
  const press = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const wasBusy = editor.editing !== undefined || linking.picking !== undefined || linking.offer !== undefined;
    pressPlane(e, view.camera, {
      pan: view.panBy,
      click: async (at) => {
        linking.cancel();
        if (wasBusy) return;
        try {
          await editor.create({ x: at.x - NEW_BOX_OFFSET.x, y: at.y - NEW_BOX_OFFSET.y });
        } catch (error_) {
          setError(messageOf(error_));
        }
      },
    });
  };
  return { view, nodes, editor, linking, actions, press, fit, flash, error: error ?? boxes.error?.message, setError };
}

export function CanvasPane({ path }: { path: string }) {
  const [plane, setPlane] = useState<HTMLDivElement | null>(null);
  const { view, nodes, editor, linking, actions, press, fit, flash, error, setError } = useCanvas(path, plane);
  const { camera } = view;
  const grid = GRID_PX * camera.z;
  const { offer } = linking;
  const zoomCenter = (factor: number) => {
    if (plane) view.zoomAt(plane.clientWidth / 2, plane.clientHeight / 2, factor);
  };
  return (
    <article className="flex min-w-0 flex-1 flex-col">
      <Header path={path} nodes={nodes} error={error} onDismiss={() => setError(undefined)} />
      <div
        ref={setPlane}
        data-agent={`canvas:plane:${path}`}
        onPointerDown={press}
        // constraint: overflow-hidden still scrolls when something calls scrollIntoView, which would shift the plane off the camera
        onScroll={(e) => e.currentTarget.scrollTo(0, 0)}
        style={{ backgroundImage: "radial-gradient(circle, rgb(128 128 128 / 0.35) 1px, transparent 1.2px)", backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }}
        className={cn("relative min-h-0 flex-1 touch-none overflow-hidden bg-background select-none", linking.picking && "cursor-crosshair")}
      >
        <BoxContext value={actions}>
          <div style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})` }} className="absolute top-0 left-0 origin-top-left">
            {nodes?.map((n) => <Box key={n.id} node={n} isEditing={editor.editing === n.id} isFlashing={flash === n.id} />)}
          </div>
        </BoxContext>
        <Hints picking={linking.picking} isEmpty={nodes?.length === 0} />
        <Controls zoom={camera.z} onZoom={zoomCenter} onFit={fit} />
      </div>
      {offer && <LinkOffer at={offer.at} onLink={() => linking.startLink(offer.selected)} />}
    </article>
  );
}
