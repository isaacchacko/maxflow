import type { KeyboardEvent, MouseEvent, WheelEvent } from "react";

export type InputAsk =
  | { type: "mouse"; kind: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button: string; clickCount: number; modifiers: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { type: "key"; kind: "keyDown" | "rawKeyDown" | "keyUp"; key: string; code: string; keyCode: number; text: string; modifiers: number }
  | { type: "text"; text: string };

const BUTTONS = ["left", "middle", "right"];
const MOUSE_KINDS: Partial<Record<string, "mousePressed" | "mouseReleased" | "mouseMoved">> = { mousedown: "mousePressed", mouseup: "mouseReleased", mousemove: "mouseMoved" };
const VIRTUAL_KEYS: Partial<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

type Modified = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

export function modifiersOf(e: Modified) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function pagePoint(e: MouseEvent<HTMLImageElement>) {
  const img = e.currentTarget;
  const box = img.getBoundingClientRect();
  return { x: Math.round(((e.clientX - box.left) * img.naturalWidth) / box.width), y: Math.round(((e.clientY - box.top) * img.naturalHeight) / box.height) };
}

export function mouseAsk(e: MouseEvent<HTMLImageElement>): InputAsk | undefined {
  const kind = MOUSE_KINDS[e.type];
  if (kind === undefined) return;
  const button = kind === "mouseMoved" ? "none" : (BUTTONS[e.button] ?? "left");
  return { type: "mouse", kind, ...pagePoint(e), button, clickCount: kind === "mouseMoved" ? 0 : e.detail, modifiers: modifiersOf(e) };
}

export function wheelAsk(e: WheelEvent<HTMLImageElement>): InputAsk {
  return { type: "wheel", ...pagePoint(e), deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) };
}

const typedText = (e: KeyboardEvent) => {
  if (e.key === "Enter") return "\r";
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : "";
};

const virtualKeyOf = (key: string) => VIRTUAL_KEYS[key] ?? (/^[\da-z]$/i.test(key) ? key.toUpperCase().codePointAt(0) ?? 0 : 0);

function keyKind(e: KeyboardEvent, text: string) {
  if (e.type === "keyup") return "keyUp";
  return text === "" ? "rawKeyDown" : "keyDown";
}

export function keyAsk(e: KeyboardEvent): InputAsk {
  const text = e.type === "keydown" ? typedText(e) : "";
  return { type: "key", kind: keyKind(e, text), key: e.key, code: e.code, keyCode: virtualKeyOf(e.key), text, modifiers: modifiersOf(e) };
}
