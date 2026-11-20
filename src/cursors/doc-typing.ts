import { EditorView } from "@codemirror/view";
import type { Point } from "./geometry";

const CHANGE_WAIT_MS = 900;
const LINES_TYPED_AT_MOST = 4;

type Steps = { release: () => void; typeIn: (el: HTMLElement, text: string) => Promise<void>; moveTo: (at: Point) => Promise<void>; check: () => void };

function changedLines(view: EditorView, before: string) {
  const old = before.split("\n");
  const doc = view.state.doc;
  let first = 0;
  while (first < old.length && first < doc.lines && old[first] === doc.line(first + 1).text) first += 1;
  let fromEnd = 0;
  while (fromEnd < old.length - first && fromEnd < doc.lines - first && old[old.length - 1 - fromEnd] === doc.line(doc.lines - fromEnd).text) fromEnd += 1;
  const last = doc.lines - fromEnd;
  return Array.from({ length: Math.max(0, Math.min(last - first, LINES_TYPED_AT_MOST)) }, (_, i) => doc.line(first + i + 1));
}

const lineElement = (view: EditorView, from: number) => {
  const { node } = view.domAtPos(from);
  return (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>(".cm-line") ?? undefined;
};

export async function typeIntoDoc(target: Element, { release, typeIn, moveTo, check }: Steps) {
  const dom = target.querySelector<HTMLElement>(".cm-editor") ?? target.closest<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) {
    release();
    return;
  }
  const before = view.state.doc.toString();
  release();
  const until = performance.now() + CHANGE_WAIT_MS;
  while (view.state.doc.toString() === before && performance.now() < until) {
    await new Promise(requestAnimationFrame);
    check();
  }
  const lines = changedLines(view, before)
    .map(line => ({ line, el: lineElement(view, line.from) }))
    .filter((x): x is { line: typeof x.line; el: HTMLElement } => x.el !== undefined);
  const first = lines[0]?.el.getBoundingClientRect();
  if (!first) return;
  await moveTo({ x: first.left + 8, y: first.top + first.height / 2 });
  for (const { line, el } of lines) await typeIn(el, line.text);
}
