import { toCanvas } from "html-to-image";
import type { Rect } from "./region";

const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const SEE_THROUGH = /rgba\(.*,\s*0\)$/;

function backgroundUnder(el: Element) {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const bg = getComputedStyle(e).backgroundColor;
    if (bg !== "" && bg !== "transparent" && !SEE_THROUGH.test(bg)) return bg;
  }
  return getComputedStyle(document.body).backgroundColor;
}

type Scrolled = { el: Element; top: number; left: number };

function shiftChildren(el: Element, translate: string) {
  for (const child of el.children) if (child instanceof HTMLElement || child instanceof SVGElement) child.style.translate = translate;
}

function unscrollKeepingTheLook(all: Element[]): Scrolled[] {
  const scrolled = all.filter(el => el.scrollTop !== 0 || el.scrollLeft !== 0).map(el => ({ el, top: el.scrollTop, left: el.scrollLeft }));
  for (const { el, top, left } of scrolled) {
    shiftChildren(el, `${-left}px ${-top}px`);
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }
  return scrolled;
}

function rescroll(scrolled: Scrolled[]) {
  for (const { el, top, left } of scrolled) {
    shiftChildren(el, "");
    el.scrollTop = top;
    el.scrollLeft = left;
  }
}

const isOutside = (r: DOMRect, rect: Rect) => r.bottom < rect.y || r.top > rect.y + rect.h || r.right < rect.x || r.left > rect.x + rect.w;

type Blanked = { img: HTMLImageElement; src: string | null; srcset: string | null; width: string; height: string };

function blankPicturesOutside(all: Element[], rect: Rect): Blanked[] {
  const away = all
    .filter((el): el is HTMLImageElement => el instanceof HTMLImageElement)
    .filter(img => isOutside(img.getBoundingClientRect(), rect))
    .map(img => ({ img, src: img.getAttribute("src"), srcset: img.getAttribute("srcset"), width: img.style.width, height: img.style.height, w: img.offsetWidth, h: img.offsetHeight }));
  for (const { img, w, h } of away) {
    Object.assign(img.style, { width: `${w}px`, height: `${h}px` });
    img.removeAttribute("srcset");
    img.src = BLANK_PIXEL;
  }
  return away;
}

function restorePictures(away: Blanked[]) {
  for (const a of away) {
    if (a.src !== null) a.img.setAttribute("src", a.src);
    if (a.srcset !== null) a.img.setAttribute("srcset", a.srcset);
    Object.assign(a.img.style, { width: a.width, height: a.height });
  }
}

// constraint: html-to-image 1.11 rejects the whole shot when an <img> has no src, and CodeMirror puts src-less cm-widgetBuffer images beside every inline widget
const isImageWithNothingToDraw = (node: Node) => node instanceof HTMLImageElement && (node.getAttribute("src") ?? "") === "";

const isLeftOutOfTheShot = (node: Node) => node instanceof HTMLIFrameElement || isImageWithNothingToDraw(node) || (node instanceof HTMLElement && node.dataset["captureUi"] !== undefined);

async function drawCutTo(rect: Rect, target: HTMLElement) {
  const ratio = Math.min(devicePixelRatio, 2);
  const box = target.getBoundingClientRect();
  const page = await toCanvas(target, {
    pixelRatio: ratio,
    width: box.width,
    height: box.height,
    backgroundColor: backgroundUnder(target),
    filter: node => !isLeftOutOfTheShot(node),
    imagePlaceholder: BLANK_PIXEL,
    // constraint: the app's fonts are the system's, and embedding every stylesheet's fonts is what breaks html-to-image's shot
    skipFonts: true,
  });
  const out = document.createElement("canvas");
  out.width = Math.round(rect.w * ratio);
  out.height = Math.round(rect.h * ratio);
  const context = out.getContext("2d");
  if (!context) throw new Error("the browser wouldn't give a canvas to draw on");
  context.drawImage(page, (rect.x - box.x) * ratio, (rect.y - box.y) * ratio, out.width, out.height, 0, 0, out.width, out.height);
  return await new Promise<Blob>((resolve, reject) => {
    out.toBlob(b => {
      if (b) resolve(b);
      else reject(new Error("the picture came out empty"));
    }, "image/png");
  });
}

export async function captureRegion(rect: Rect, target: HTMLElement) {
  const all = [target, ...target.querySelectorAll("*")];
  const scrolled = unscrollKeepingTheLook(all);
  const away = blankPicturesOutside(all, rect);
  const root = document.documentElement;
  const wasViewing = root.dataset["viewing"] !== undefined;
  root.dataset["viewing"] = "";
  try {
    return await drawCutTo(rect, target);
  } finally {
    if (!wasViewing) delete root.dataset["viewing"];
    restorePictures(away);
    rescroll(scrolled);
  }
}
