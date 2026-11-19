import { toCanvas } from "html-to-image";
import { useRef, useState } from "react";
import { useEventListener } from "@/lib/effects";
import { Kbd } from "@/components/ui/kbd";
import { startThread } from "@/store";

type Rect = { x: number; y: number; w: number; h: number };
// png and preview arrive after the popover is up: it opens at once and the picture renders behind it.
type Shot = { rect: Rect; png?: Blob; preview?: string; context: string; target: Element };

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

/** The smallest element that holds all of `rect`: the one drawn for it, so a shot of one message clones that message, not the page. */
function holder(rect: Rect, overlay: Element | null) {
  let el = under(rect.x + rect.w / 2, rect.y + rect.h / 2, overlay) ?? document.body;
  // It must also fit in the window: a long list scrolled past the top is drawn whole and cut, so its scroll box is taken instead.
  const holds = (e: Element) => { const r = e.getBoundingClientRect(); return r.left <= rect.x + 1 && r.top <= rect.y + 1 && r.right >= rect.x + rect.w - 1 && r.bottom >= rect.y + rect.h - 1 && r.top >= -1 && r.bottom <= innerHeight + 1; };
  while (el !== document.body && !holds(el)) el = el.parentElement ?? document.body;
  return el;
}

// Background a transparent element sits on, so a shot of a row isn't see-through.
function backdrop(el: Element) {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const bg = getComputedStyle(e).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return getComputedStyle(document.body).backgroundColor;
}

/**
 * `target` drawn into a canvas, cut to `rect`: only its subtree is cloned and inlined, at no more than 2x, with the page's
 * animations paused for the moment. A scrolled container would be cloned at its top, so for the capture each one inside it is put
 * back to scroll 0 with its content shifted by the same amount, which looks identical.
 */
async function capture(rect: Rect, target: Element) {
  const all = [target, ...target.querySelectorAll("*")] as HTMLElement[];
  const scrolled = all.filter(el => el.scrollTop || el.scrollLeft).map(el => ({ el, top: el.scrollTop, left: el.scrollLeft }));
  for (const { el, top, left } of scrolled) {
    for (const child of el.children) (child as HTMLElement).style.translate = `${-left}px ${-top}px`;
    el.scrollTop = el.scrollLeft = 0;
  }
  // A picture outside the region would still be fetched and inlined (a channel's every screenshot): for the moment of the shot it is
  // a blank pixel held at its own size, so nothing moves and nothing visible changes.
  const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  const away = (all.filter(el => el instanceof HTMLImageElement) as HTMLImageElement[])
    .filter(img => { const r = img.getBoundingClientRect(); return r.bottom < rect.y || r.top > rect.y + rect.h || r.right < rect.x || r.left > rect.x + rect.w; })
    .map(img => ({ img, src: img.getAttribute("src"), srcset: img.getAttribute("srcset"), width: img.style.width, height: img.style.height, w: img.offsetWidth, h: img.offsetHeight }));
  for (const a of away) Object.assign(a.img.style, { width: `${a.w}px`, height: `${a.h}px` }), a.img.removeAttribute("srcset"), (a.img.src = BLANK);
  const viewing = document.documentElement.hasAttribute("data-viewing");
  document.documentElement.setAttribute("data-viewing", "");
  try {
    const ratio = Math.min(devicePixelRatio, 2);
    const box = target.getBoundingClientRect();
    const page = await toCanvas(target as HTMLElement, {
      pixelRatio: ratio,
      width: box.width,
      height: box.height,
      backgroundColor: backdrop(target),
      // Another page or a live terminal can't be cloned, and would only slow the shot.
      // The capture's own popover sits over the page while it renders; a shot of the whole page leaves it out.
      filter: node => !(node instanceof HTMLIFrameElement) && !(node instanceof HTMLElement && node.dataset.captureUi !== undefined),
      // A picture that can't be fetched (another site's, without CORS) is left blank rather than failing the shot.
      imagePlaceholder: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      // The app's fonts are the system's; embedding every stylesheet's fonts is what breaks the shot.
      skipFonts: true,
    });
    const out = document.createElement("canvas");
    out.width = Math.round(rect.w * ratio);
    out.height = Math.round(rect.h * ratio);
    out.getContext("2d")!.drawImage(page, (rect.x - box.x) * ratio, (rect.y - box.y) * ratio, out.width, out.height, 0, 0, out.width, out.height);
    return await new Promise<Blob>((resolve, reject) => out.toBlob(b => (b ? resolve(b) : reject(new Error("empty capture"))), "image/png"));
  } finally {
    if (!viewing) document.documentElement.removeAttribute("data-viewing");
    for (const a of away) {
      if (a.src !== null) a.img.setAttribute("src", a.src);
      if (a.srcset !== null) a.img.setAttribute("srcset", a.srcset);
      Object.assign(a.img.style, { width: a.width, height: a.height });
    }
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

/** ⌘⇧S / Ctrl+Shift+S: drag a region or click a thing, add a comment, and it goes to the funnel as an inbox message. */
export function Capture() {
  const [mode, setMode] = useState<"off" | "picking" | "shooting" | "comment">("off");
  const [drag, setDragState] = useState<{ x0: number; y0: number; rect: Rect } | null>(null);
  // Mirrored in a ref, so a mouseup that lands before the last move re-rendered still sees the whole drag.
  const dragRef = useRef<typeof drag>(null);
  const setDrag = (d: typeof drag) => ((dragRef.current = d), setDragState(d));
  const [hover, setHover] = useState<Rect | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const overlay = useRef<HTMLDivElement>(null);
  // Bumped by each shot and each reset, so a capture that finishes after he cancelled is dropped.
  const taking = useRef(0);
  // Hover hit-testing waits for the next frame and runs once per frame, however fast the mouse moves.
  const frame = useRef(0);
  const sendWhenReady = useRef(false);
  // The picture finishes after the render that started it; sending then uses the comment as he has typed it since.
  const sendLatest = useRef(send);
  sendLatest.current = send;

  function reset() {
    if (shot?.preview) URL.revokeObjectURL(shot.preview);
    taking.current += 1;
    sendWhenReady.current = false;
    setMode("off"), setDrag(null), setHover(null), setShot(null), setComment(""), setError("");
  }

  useEventListener(
    "keydown",
    e => {
      if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
        e.preventDefault(), e.stopPropagation();
        setMode(m => (m === "off" ? "picking" : m));
      } else if (e.key === "Escape" && mode === "picking") {
        e.preventDefault(), e.stopPropagation();
        reset();
      }
    },
    { capture: true },
  );

  // The popover opens at once with the comment box focused, and the picture renders behind it: he types while it draws.
  async function take(rect: Rect, picked?: Element) {
    // A pick partly scrolled out of view is taken through its holder, for the same reason.
    if (rect.w < 2 || rect.h < 2) return reset();
    const context = contextOf(rect, overlay.current);
    const seen = picked?.getBoundingClientRect();
    const target = picked && seen && seen.top >= -1 && seen.bottom <= innerHeight + 1 ? picked : holder(rect, overlay.current);
    const mine = ++taking.current;
    // An open dialog (⌘K) is in the shot, so it closes only once the picture is taken; until then the popover sits over it.
    const dialog = document.querySelector('[role="dialog"]');
    setShot({ rect, context, target });
    setMode("comment");
    try {
      // The overlay unmounts first, so it isn't in the shot: the popover draws over the page, but outside the captured subtree.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const png = await capture(rect, target);
      if (mine !== taking.current) return;
      setShot(s => s && { ...s, png, preview: URL.createObjectURL(png) });
      if (sendWhenReady.current) (sendWhenReady.current = false), void sendLatest.current(png);
      // The Escape goes to the dialog's input, which the app's own Escape (back out of a page) ignores.
      if (dialog?.isConnected) (dialog.querySelector("input") ?? dialog).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch (err) {
      if (mine === taking.current) setError(`Couldn't capture: ${err instanceof Event ? `a ${err.type} drawing the page` : String(err)}`);
    }
  }

  async function send(png = shot?.png) {
    if (!shot || !png) return;
    setMode("shooting");
    try {
      const res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": "image/png" }, body: png });
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
      {mode === "picking" && (
        <div
          ref={overlay}
          data-agent="capture-overlay"
          className="pointer-events-auto fixed inset-0 z-[100] cursor-crosshair"
          onMouseDown={e => setDrag({ x0: e.clientX, y0: e.clientY, rect: { x: e.clientX, y: e.clientY, w: 0, h: 0 } })}
          onMouseMove={e => {
            const d = dragRef.current;
            if (d) return setDrag({ ...d, rect: { x: Math.min(d.x0, e.clientX), y: Math.min(d.y0, e.clientY), w: Math.abs(e.clientX - d.x0), h: Math.abs(e.clientY - d.y0) } });
            const { clientX: x, clientY: y } = e;
            cancelAnimationFrame(frame.current);
            frame.current = requestAnimationFrame(() => {
              const snap = under(x, y, overlay.current)?.closest(SNAP);
              setHover(snap ? rectOf(snap) : null);
            });
          }}
          onMouseUp={e => {
            const r = dragRef.current?.rect;
            setDrag(null);
            if (r && (r.w > CLICK || r.h > CLICK)) return void take(r);
            const snap = under(e.clientX, e.clientY, overlay.current)?.closest(SNAP);
            if (snap) void take(rectOf(snap), snap);
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
        <div data-capture-ui className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/30" onMouseDown={e => e.target === e.currentTarget && reset()}>
          <div data-agent="capture-popover" className="flex w-[min(36rem,calc(100%-2rem))] flex-col gap-2 rounded-2xl border bg-card p-3 shadow-lg">
            {shot?.preview ? (
              <img src={shot.preview} alt="" className="max-h-64 self-start border object-contain" />
            ) : (
              shot &&
              !error && (
                <div data-agent="capture-rendering" style={{ aspectRatio: `${shot.rect.w} / ${shot.rect.h}` }} className="flex max-h-64 w-full max-w-full animate-pulse items-center justify-center self-start border bg-muted text-xs text-muted-foreground">
                  rendering…
                </div>
              )
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <input
              autoFocus
              data-agent="capture-comment"
              value={comment}
              disabled={mode === "shooting"}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => {
                e.stopPropagation();
                // Enter before the picture is ready sends once it is.
                if (e.key === "Enter") e.preventDefault(), shot?.png ? void send() : (sendWhenReady.current = true);
                if (e.key === "Escape") e.preventDefault(), reset();
              }}
              placeholder="Say what this is about, Enter sends it to the funnel"
              className="rounded-xl border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60"
            />
            <p className="text-[11px] text-muted-foreground">
              {mode === "shooting" ? "Sending…" : !shot?.png && sendWhenReady.current ? "Sends when the picture is ready…" : <>Starts an inbox thread with the screenshot and where it was taken · <Kbd>↵</Kbd> send · <Kbd>esc</Kbd> cancel</>}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
