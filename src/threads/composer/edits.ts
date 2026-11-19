import { Bold, Code, Italic, Link2, List, ListOrdered, SquareCode, Strikethrough } from "lucide-react";

export type Edit = { value: string; start: number; end: number };

function toggleAround({ value, start, end }: Edit, before: string, after = before): Edit {
  const sel = value.slice(start, end);
  if (value.slice(start - before.length, start) === before && value.slice(end, end + after.length) === after)
    return { value: value.slice(0, start - before.length) + sel + value.slice(end + after.length), start: start - before.length, end: end - before.length };
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length)
    return { value: value.slice(0, start) + sel.slice(before.length, sel.length - after.length) + value.slice(end), start, end: end - before.length - after.length };
  return { value: value.slice(0, start) + before + sel + after + value.slice(end), start: start + before.length, end: end + before.length };
}

const NUMBERED_MARKER = /^\d+\. /;
const BULLET_MARKER = /^[-*] /;
const ANY_MARKER = /^(\d+\. |[-*] )/;

function toggleListMarkers({ value, start, end }: Edit, isNumbered: boolean): Edit {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end);
  const to = lineEnd === -1 ? value.length : lineEnd;
  const lines = value.slice(from, to).split("\n");
  const marker = isNumbered ? NUMBERED_MARKER : BULLET_MARKER;
  const unmark = (l: string) => l.replace(marker, "");
  const remark = (l: string, i: number) => (isNumbered ? `${i + 1}. ` : "- ") + l.replace(ANY_MARKER, "");
  const text = lines.map(lines.every(l => marker.test(l)) ? unmark : remark).join("\n");
  return { value: value.slice(0, from) + text + value.slice(to), start: from, end: from + text.length };
}

function linkSelection({ value, start, end }: Edit): Edit {
  const sel = value.slice(start, end);
  if (/^https?:\/\/\S+$/.test(sel)) return { value: `${value.slice(0, start)}[](${sel})${value.slice(end)}`, start: start + 1, end: start + 1 };
  const text = `[${sel === "" ? "text" : sel}](url)`;
  const urlToTypeOver = start + text.length - 4;
  return { value: value.slice(0, start) + text + value.slice(end), start: urlToTypeOver, end: urlToTypeOver + 3 };
}

export function insertAtSelection(text: string) {
  return ({ value, start, end }: Edit): Edit => ({ value: value.slice(0, start) + text + value.slice(end), start: start + text.length, end: start + text.length });
}

export function mentionAtWordStart({ value, start, end }: Edit): Edit {
  const pad = start > 0 && !/\s/.test(value.at(start - 1) ?? "") ? " @" : "@";
  return { value: value.slice(0, start) + pad + value.slice(end), start: start + pad.length, end: start + pad.length };
}

type Format = { label: string; keys?: string; icon: React.ComponentType<{ className?: string }>; apply: (e: Edit) => Edit };

export const FORMATS: Format[] = [
  { label: "Bold", keys: "⌘B", icon: Bold, apply: e => toggleAround(e, "**") },
  { label: "Italic", keys: "⌘I", icon: Italic, apply: e => toggleAround(e, "_") },
  { label: "Strikethrough", keys: "⌘⇧X", icon: Strikethrough, apply: e => toggleAround(e, "~~") },
  // constraint: Link has no ⌘K because the quick switcher owns ⌘K, in this box too
  { label: "Link", icon: Link2, apply: linkSelection },
  { label: "Numbered list", keys: "⌘⇧7", icon: ListOrdered, apply: e => toggleListMarkers(e, true) },
  { label: "Bulleted list", keys: "⌘⇧8", icon: List, apply: e => toggleListMarkers(e, false) },
  { label: "Code", keys: "⌘⇧C", icon: Code, apply: e => toggleAround(e, "`") },
  { label: "Code block", keys: "⌘⌥⇧C", icon: SquareCode, apply: e => toggleAround(e, "```\n", "\n```") },
];

export const FORMAT_GROUP_STARTS = new Set([3, 4, 6]);

const PLAIN_KEYS = new Map([
  ["b", "Bold"],
  ["i", "Italic"],
]);
const SHIFT_KEYS = new Map([
  ["x", "Strikethrough"],
  ["7", "Numbered list"],
  ["8", "Bulleted list"],
  ["c", "Code"],
]);
const SHIFT_ALT_KEYS = new Map([["c", "Code block"]]);
const NO_KEYS = new Map<string, string>();

function shortcutsFor(e: React.KeyboardEvent) {
  if (e.altKey) return e.shiftKey ? SHIFT_ALT_KEYS : NO_KEYS;
  return e.shiftKey ? SHIFT_KEYS : PLAIN_KEYS;
}

export function formatForPhysicalKey(e: React.KeyboardEvent) {
  if (!e.metaKey && !e.ctrlKey) return;
  const physicalKey = e.code.replace(/^(Key|Digit)/, "").toLowerCase();
  const name = shortcutsFor(e).get(physicalKey);
  return FORMATS.find(f => f.label === name);
}
