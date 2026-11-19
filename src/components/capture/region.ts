export type Rect = { x: number; y: number; w: number; h: number };

export const CLICK_SLOP_PX = 4;
export const ONE_THING_A_CLICK = "article, [data-agent], li, section, aside, header";

export const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

export function elementUnder(x: number, y: number, overlay: Element | null) {
  return document.elementsFromPoint(x, y).find(el => overlay?.contains(el) !== true);
}

export const elementAtMiddle = (rect: Rect, overlay: Element | null) => elementUnder(rect.x + rect.w / 2, rect.y + rect.h / 2, overlay);

const isInsideTheWindow = (r: DOMRect) => r.top >= -1 && r.bottom <= innerHeight + 1;

function doesHoldWithinTheWindow(el: Element, rect: Rect) {
  const r = el.getBoundingClientRect();
  return r.left <= rect.x + 1 && r.top <= rect.y + 1 && r.right >= rect.x + rect.w - 1 && r.bottom >= rect.y + rect.h - 1 && isInsideTheWindow(r);
}

function smallestHolder(rect: Rect, overlay: Element | null): HTMLElement {
  let el: Element = elementAtMiddle(rect, overlay) ?? document.body;
  while (el !== document.body && !(el instanceof HTMLElement && doesHoldWithinTheWindow(el, rect))) el = el.parentElement ?? document.body;
  return el instanceof HTMLElement ? el : document.body;
}

export function captureTarget(rect: Rect, picked: Element | undefined, overlay: Element | null) {
  if (picked instanceof HTMLElement && isInsideTheWindow(picked.getBoundingClientRect())) return picked;
  return smallestHolder(rect, overlay);
}
