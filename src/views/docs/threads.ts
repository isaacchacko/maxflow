import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type CalloutLine = { number: number; depth: number; markerLength: number; who?: string };
export type CalloutBlock = { firstLine: number; lastLine: number; who: string; isOpen: boolean; lines: CalloutLine[] };

const ISAAC = "isaac";
const FENCE = /^\s*(```|~~~)/;
const QUOTE = /^(?:>[ \t]?)+/;
const CALLOUT = /^\[!(comment|reply)\][+-]?[ \t]*(.*)$/i;

const signed = (name: string | undefined) => (name === undefined || name.trim() === "" ? ISAAC : name.trim());

function calloutLine(number: number, text: string): CalloutLine | undefined {
  const marker = QUOTE.exec(text)?.[0];
  if (marker === undefined) return undefined;
  const callout = CALLOUT.exec(text.slice(marker.length));
  const depth = marker.split(">").length - 1;
  return { number, depth, markerLength: marker.length, ...(callout && { who: signed(callout[2]) }) };
}

function closeBlock(block: CalloutBlock) {
  const lastWho = block.lines.findLast((l) => l.who !== undefined)?.who ?? block.who;
  return { ...block, isOpen: lastWho.toLowerCase() === ISAAC };
}

function isCommentStart(state: EditorState, line: CalloutLine) {
  const text = state.doc.line(line.number).text.slice(line.markerLength);
  return line.depth === 1 && /^\[!comment\]/i.test(text);
}

export function calloutBlocks(state: EditorState): CalloutBlock[] {
  const blocks: CalloutBlock[] = [];
  let current: CalloutBlock | undefined;
  let isInCode = false;
  for (let n = 1; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text;
    if (FENCE.test(text)) isInCode = !isInCode;
    const line = isInCode ? undefined : calloutLine(n, text);
    if (line && isCommentStart(state, line)) {
      if (current) blocks.push(closeBlock(current));
      current = { firstLine: n, lastLine: n, who: line.who ?? ISAAC, isOpen: true, lines: [line] };
    } else if (line && current) {
      current.lines.push(line);
      current.lastLine = n;
    } else if (current) {
      blocks.push(closeBlock(current));
      current = undefined;
    }
  }
  if (current) blocks.push(closeBlock(current));
  return blocks;
}

const blockAt = (state: EditorState, firstLine: number) => calloutBlocks(state).find((b) => b.firstLine === firstLine);

export function replyInto(view: EditorView, firstLine: number) {
  const block = blockAt(view.state, firstLine);
  if (!block) return;
  const end = view.state.doc.line(block.lastLine).to;
  const insert = `\n> > [!reply] ${ISAAC}\n> > `;
  view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length } });
  view.focus();
}

export function resolveBlock(view: EditorView, firstLine: number) {
  const block = blockAt(view.state, firstLine);
  if (!block) return;
  const { doc } = view.state;
  const from = doc.line(block.firstLine).from;
  const to = Math.min(doc.length, doc.line(block.lastLine).to + 1);
  const isAfterBlank = block.firstLine > 1 && doc.line(block.firstLine - 1).text.trim() === "";
  view.dispatch({ changes: { from: isAfterBlank ? from - 1 : from, to } });
}

function endOfBlockAt(state: EditorState, pos: number) {
  let line = state.doc.lineAt(pos);
  while (line.number < state.doc.lines && state.doc.line(line.number + 1).text.trim() !== "") line = state.doc.line(line.number + 1);
  return line.to;
}

export function didCommentOnSelection(view: EditorView) {
  const { state } = view;
  const range = state.selection.main;
  const quote = state.sliceDoc(range.from, range.to).replaceAll(/\s+/g, " ").trim().slice(0, 120);
  const end = endOfBlockAt(state, range.to);
  const insert = `\n\n> [!comment]\n> ${quote === "" ? "" : `“${quote}” `}`;
  view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length } });
  view.focus();
  return true;
}
