import { toCanvas } from "html-to-image";
import { Camera } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { startThread } from "@/store";

type Rect = { x: number; y: number; w: number; h: number };
type Shot = { rect: Rect; png: Blob; preview: string; context: string };

const CLICK = 4;
// A click snaps to the smallest of these around the point, so one message, card or row is one click.
const SNAP = "article, [data-agent], li, section, aside, header";

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

/** The element under a point, ignoring the capture overlay itself. */
function under(x: number, y: number, overlay: Element | null) {
  return document.elementsFromPoint(x, y).find(el => !overlay?.contains(el));
}

/**
 * The page drawn into a canvas, cut to `rect`. A scrolled container would be cloned at its top, so for the moment of the
 * capture each one is put back to scroll 0 with its content shifted by the same amount, which looks identical.
 */
async function capture(rect: Rect) {
  const scrolled = [...document.querySelectorAll<HTMLElement>("body *")].filter(el => el.scrollTop || el.scrollLeft).map(el => ({ el, top: el.scrollTop, left: el.scrollLeft }));
  for (const { el, top, left } of scrolled) {
    for (const child of el.children) (child as HTMLElement).style.translate = `${-left}px ${-top}px`;
    el.scrollTop = el.scrollLeft = 0;
  }
  try {
    const ratio = devicePixelRatio;
    const page = await toCanvas(document.body, {
      pixelRatio: ratio,
      width: innerWidth,
      height: innerHeight,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      // A picture that can't be fetched (another site's, without CORS) is left blank rather than failing the shot.
      imagePlaceholder: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      // The app's fonts are the system's; embedding every stylesheet's fonts is what breaks the shot.
      skipFonts: true,
    });
    const out = document.createElement("canvas");
    out.width = Math.round(rect.w * ratio);
    out.height = Math.round(rect.h * ratio);
    out.getContext("2d")!.drawImage(page, rect.x * ratio, rect.y * ratio, out.width, out.height, 0, 0, out.width, out.height);
    return await new Promise<Blob>((resolve, reject) => out.toBlob(b => (b ? resolve(b) : reject(new Error("empty capture"))), "image/png"));
  } finally {
    for (const { el, top, left } of scrolled) {
      for (const child of el.children) (child as HTMLElement).style.translate = "";
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }
}

const ENTITY = /^#(thread|agent|objective|task)\/([^/?#]+)(\/.*)?$/;
const chip = (kind: string, id: string) => `[[${kind}:${decodeURIComponent(id)}]]`;

/** Where the shot was taken, as chips: the page's entity, and the message, card or link nearest the middle of the region. */
function contextOf(rect: Rect, overlay: Element | null) {
  const hash = location.hash || "#inbox";
  const page = hash.match(ENTITY);
  const parts = [`page ${page ? `${chip(page[1]!, page[2]!)}${page[3] ? ` (${page[3].slice(1)})` : ""}` : `\`${hash}\``}`];
  const el = under(rect.x + rect.w / 2, rect.y + rect.h / 2, overlay);
  const message = el?.closest<HTMLElement>("article[data-from]");
  if (message) {
    const from = message.dataset.from!;
    const words = message.querySelector(".leading-relaxed")?.textContent?.trim().replace(/\s+/g, " ").slice(0, 80);
    parts.push(`message from ${from === "isaac" ? "Isaac" : chip("agent", from)} at ${message.dataset.at?.slice(11, 16)}${words ? ` ("${words}…")` : ""}`);
  }
  const link = el?.closest<HTMLAnchorElement>("a[href^='#']")?.getAttribute("href")?.match(ENTITY) ?? message?.querySelector<HTMLAnchorElement>("a[href^='#']")?.getAttribute("href")?.match(ENTITY);
  const same = (kind?: string, id?: string) => link && link[1] === kind && link[2] === id;
  if (link && !same(page?.[1], page?.[2]) && !same("agent", message?.dataset.from)) parts.push(`pointing at ${chip(link[1]!, link[2]!)}`);
  const marked = el?.closest<HTMLElement>("[data-agent]")?.dataset.agent;
  if (marked) parts.push(`element \`${marked}\``);
  return `[maxflow · screenshot] ${parts.join(" · ")}`;
}

/** ⌘⇧S / Ctrl+Shift+S, or the camera: drag a region or click a thing, add a comment, and it goes to the funnel as an inbox message. */
export function Capture() {
  const [mode, setMode] = useState<"off" | "picking" | "shooting" | "comment">("off");
  const [drag, setDrag] = useState<{ x0: number; y0: number; rect: Rect } | null>(null);
  const [hover, setHover] = useState<Rect | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const overlay = useRef<HTMLDivElement>(null);

  function reset() {
    if (shot) URL.revokeObjectURL(shot.preview);
    setMode("off"), setDrag(null), setHover(null), setShot(null), setComment(""), setError("");
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
        e.preventDefault(), e.stopPropagation();
        setMode(m => (m === "off" ? "picking" : m));
      } else if (e.key === "Escape" && mode === "picking") {
        e.preventDefault(), e.stopPropagation();
        reset();
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  });

  async function take(rect: Rect) {
    if (rect.w < 2 || rect.h < 2) return reset();
    setMode("shooting");
    const context = contextOf(rect, overlay.current);
    try {
      // The overlay unmounts first, so it isn't in the shot.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const png = await capture(rect);
      setShot({ rect, png, preview: URL.createObjectURL(png), context });
      // An open dialog (⌘K) keeps focus to itself; it was in the shot, now it closes so the comment box can type. The Escape
      // goes to its input, which the app's own Escape (back out of a page) ignores.
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) (dialog.querySelector("input") ?? dialog).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      setMode("comment");
    } catch (err) {
      setError(`Couldn't capture: ${err instanceof Event ? `a ${err.type} drawing the page` : String(err)}`);
      setMode("comment");
    }
  }

  async function send() {
    if (!shot) return;
    setMode("shooting");
    try {
      const res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": "image/png" }, body: shot.png });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { path } = (await res.json()) as { path: string };
      await startThread([comment.trim(), `![screenshot](${path})`, shot.context].filter(Boolean).join("\n"));
      reset();
    } catch (err) {
      setError(String(err));
      setMode("comment");
    }
  }

  const box = drag?.rect ?? hover;
  return (
    <>
      <Button variant="ghost" size="icon" title="Screenshot to the funnel (⌘⇧S)" data-agent="capture" onClick={() => setMode("picking")}>
        <Camera />
      </Button>
      {mode === "picking" && (
        <div
          ref={overlay}
          data-agent="capture-overlay"
          className="pointer-events-auto fixed inset-0 z-[100] cursor-crosshair"
          onMouseDown={e => setDrag({ x0: e.clientX, y0: e.clientY, rect: { x: e.clientX, y: e.clientY, w: 0, h: 0 } })}
          onMouseMove={e => {
            if (drag) return setDrag({ ...drag, rect: { x: Math.min(drag.x0, e.clientX), y: Math.min(drag.y0, e.clientY), w: Math.abs(e.clientX - drag.x0), h: Math.abs(e.clientY - drag.y0) } });
            const snap = under(e.clientX, e.clientY, overlay.current)?.closest(SNAP);
            setHover(snap ? rectOf(snap) : null);
          }}
          onMouseUp={e => {
            const r = drag?.rect;
            setDrag(null);
            if (r && (r.w > CLICK || r.h > CLICK)) return void take(r);
            const snap = under(e.clientX, e.clientY, overlay.current)?.closest(SNAP);
            if (snap) void take(rectOf(snap));
          }}
        >
          {/* Everything outside the box is dimmed; the box is the part that will be captured. */}
          {box ? <div className="absolute rounded-md border-2 border-link shadow-[0_0_0_9999px_rgb(0_0_0/0.45)]" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} /> : <div className="absolute inset-0 bg-black/45" />}
          <p className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-raised">
            Drag a region or click a message, card or row · <Kbd>esc</Kbd> cancels
          </p>
        </div>
      )}
      {(mode === "comment" || (mode === "shooting" && shot)) && (
        <div className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/30" onMouseDown={e => e.target === e.currentTarget && reset()}>
          <div data-agent="capture-popover" className="flex w-[min(36rem,calc(100%-2rem))] flex-col gap-2 rounded-2xl border bg-card p-3 shadow-lg">
            {shot && <img src={shot.preview} alt="" className="max-h-64 self-start border object-contain" />}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <input
              autoFocus
              data-agent="capture-comment"
              value={comment}
              disabled={mode === "shooting"}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === "Enter") e.preventDefault(), void send();
                if (e.key === "Escape") e.preventDefault(), reset();
              }}
              placeholder="Say what this is about, Enter sends it to the funnel"
              className="rounded-xl border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60"
            />
            <p className="text-[11px] text-muted-foreground">
              {mode === "shooting" ? "Sending…" : <>Starts an inbox thread with the screenshot and where it was taken · <Kbd>↵</Kbd> send · <Kbd>esc</Kbd> cancel</>}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
