import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { calloutBlocks, replyInto, resolveBlock, type CalloutBlock, type CalloutLine } from "./threads";

const hidden = Decoration.replace({});
const lineClass = (cls: string) => Decoration.line({ class: cls });
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const WIKILINK = /(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

export const fileUrl = (path: string) => `/api/docs/${encodeURIComponent(path)}`;

function resolveFrom(docPath: string, target: string) {
  if (/^(https?:|\/api\/)/.test(target)) return target;
  const folder = docPath.split("/").slice(0, -1);
  const parts = [...folder, ...decodeURI(target).split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }
  return fileUrl(resolved.join("/"));
}

const embedUrl = (name: string) => fileUrl(name.includes("/") ? name : `attachments/${name}`);

class ImageWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  override eq(other: ImageWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const img = document.createElement("img");
    img.src = this.src;
    img.className = "cm-md-image";
    return img;
  }
}

class BulletWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-md-bullet";
    dot.textContent = "•";
    return dot;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly isDone: boolean) {
    super();
  }
  override eq(other: TaskWidget) {
    return other.isDone === this.isDone;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.isDone;
    box.className = "cm-md-task";
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const at = view.posAtDOM(box);
      view.dispatch({ changes: { from: at + 1, to: at + 2, insert: this.isDone ? " " : "x" } });
    });
    return box;
  }
  override ignoreEvent() {
    return false;
  }
}

function button(label: string, act: () => void) {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = "cm-callout-button";
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    act();
  });
  return b;
}

class CommentHeader extends WidgetType {
  constructor(readonly block: CalloutBlock) {
    super();
  }
  override eq(other: CommentHeader) {
    return other.block.who === this.block.who && other.block.isOpen === this.block.isOpen && other.block.firstLine === this.block.firstLine;
  }
  toDOM(view: EditorView) {
    const header = document.createElement("span");
    header.className = "cm-callout-header";
    const who = document.createElement("span");
    who.textContent = `💬 ${this.block.who}`;
    const state = document.createElement("span");
    state.className = "cm-callout-state";
    state.textContent = this.block.isOpen ? "waiting on an answer" : "answered";
    header.append(who, state, button("Reply", () => replyInto(view, this.block.firstLine)), button("Resolve", () => resolveBlock(view, this.block.firstLine)));
    return header;
  }
  override ignoreEvent() {
    return false;
  }
}

class ReplyLabel extends WidgetType {
  constructor(readonly who: string) {
    super();
  }
  override eq(other: ReplyLabel) {
    return other.who === this.who;
  }
  toDOM() {
    const label = document.createElement("span");
    label.className = "cm-callout-who";
    label.textContent = this.who;
    return label;
  }
}

function activeLines(state: EditorState) {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) lines.add(n);
  }
  return lines;
}

type Scan = { state: EditorState; active: Set<number>; docPath: string; out: Range<Decoration>[] };

const isActive = (scan: Scan, pos: number) => scan.active.has(scan.state.doc.lineAt(pos).number);

function hideMark(scan: Scan, node: SyntaxNodeRef) {
  if (isActive(scan, node.from)) return;
  const after = scan.state.sliceDoc(node.to, node.to + 1);
  const isHeadingSpace = after === " " && node.name === "HeaderMark";
  scan.out.push(hidden.range(node.from, isHeadingSpace ? node.to + 1 : node.to));
}

function markLines(scan: Scan, node: SyntaxNodeRef, cls: string) {
  const { doc } = scan.state;
  const last = doc.lineAt(node.to).number;
  for (let n = doc.lineAt(node.from).number; n <= last; n += 1) scan.out.push(lineClass(cls).range(doc.line(n).from));
}

function image(scan: Scan, node: SyntaxNodeRef) {
  const url = node.node.getChild("URL");
  if (!url || isActive(scan, node.from)) return;
  const src = resolveFrom(scan.docPath, scan.state.sliceDoc(url.from, url.to));
  scan.out.push(Decoration.replace({ widget: new ImageWidget(src) }).range(node.from, node.to));
}

function listMark(scan: Scan, node: SyntaxNodeRef) {
  if (node.node.parent?.parent?.name !== "BulletList" || isActive(scan, node.from)) return;
  const task = scan.state.sliceDoc(node.to, node.to + 4);
  if (/^ \[[ xX]\]$/.test(task)) {
    scan.out.push(Decoration.replace({ widget: new TaskWidget(task[2] !== " ") }).range(node.from, node.to + 4));
    return;
  }
  scan.out.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
}

const MARKS = new Set(["EmphasisMark", "StrikethroughMark", "LinkMark", "URL"]);
const SPANS: Record<string, string> = { Emphasis: "cm-md-em", StrongEmphasis: "cm-md-strong", InlineCode: "cm-md-code", Strikethrough: "cm-md-strike", Link: "cm-md-link" };

const isHiddenMark = (node: SyntaxNodeRef) => node.name === "HeaderMark" || MARKS.has(node.name) || (node.name === "CodeMark" && node.node.parent?.name === "InlineCode");

function visitBlock(scan: Scan, node: SyntaxNodeRef) {
  switch (node.name) {
    case "FencedCode": {
      markLines(scan, node, "cm-md-codeblock");
      break;
    }
    case "Table": {
      markLines(scan, node, "cm-md-table");
      break;
    }
    case "Image": {
      image(scan, node);
      break;
    }
    case "ListMark": {
      listMark(scan, node);
      break;
    }
  }
}

function visit(scan: Scan, node: SyntaxNodeRef) {
  const heading = /^ATXHeading(\d)$/.exec(node.name)?.[1];
  if (heading !== undefined) scan.out.push(lineClass(`cm-md-h${heading}`).range(scan.state.doc.lineAt(node.from).from));
  else if (isHiddenMark(node)) hideMark(scan, node);
  else visitBlock(scan, node);
  const span = SPANS[node.name];
  if (span !== undefined && node.from < node.to) scan.out.push(Decoration.mark({ class: span }).range(node.from, node.to));
}

function wikilinks(scan: Scan, from: number, to: number) {
  const text = scan.state.sliceDoc(from, to);
  for (const m of text.matchAll(WIKILINK)) {
    const [whole, bang, target = "", alias] = m;
    const start = from + m.index;
    const isEmbed = bang === "!";
    const end = start + whole.length;
    if (!isEmbed) linkDecorations(scan, { start, end, target, alias });
    else if (IMAGE.test(target) && !isActive(scan, start)) {
      const widget = new ImageWidget(embedUrl(target));
      scan.out.push(Decoration.replace({ widget }).range(start, end));
    }
  }
}

function linkDecorations(scan: Scan, { start, end, target, alias }: { start: number; end: number; target: string; alias: string | undefined }) {
  scan.out.push(Decoration.mark({ class: "cm-md-wikilink", attributes: { "data-doc": target.trim() } }).range(start, end));
  if (isActive(scan, start)) return;
  const shownFrom = alias === undefined ? start + 2 : end - 2 - alias.length;
  scan.out.push(hidden.range(start, shownFrom), hidden.range(end - 2, end));
}

const replyLabel = (line: CalloutLine) => (line.who === undefined ? undefined : new ReplyLabel(line.who));

function callouts(scan: Scan) {
  for (const block of calloutBlocks(scan.state)) {
    for (const line of block.lines) {
      const at = scan.state.doc.line(line.number);
      scan.out.push(lineClass(`cm-callout${block.isOpen ? " cm-callout-open" : ""}${line.depth > 1 ? " cm-callout-reply" : ""}`).range(at.from));
      if (scan.active.has(line.number)) continue;
      const header = line.number === block.firstLine ? new CommentHeader(block) : replyLabel(line);
      if (header) scan.out.push(Decoration.replace({ widget: header }).range(at.from, at.to));
      else if (line.markerLength > 0) scan.out.push(hidden.range(at.from, at.from + line.markerLength));
    }
  }
}

function decorate(view: EditorView, docPath: string): DecorationSet {
  const scan: Scan = { state: view.state, active: activeLines(view.state), docPath, out: [] };
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({ from, to, enter: (node) => visit(scan, node) });
    wikilinks(scan, from, to);
  }
  callouts(scan);
  return Decoration.set(scan.out, true);
}

export function livePreview(docPath: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view, docPath);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = decorate(u.view, docPath);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function wikilinkAt(target: EventTarget | null) {
  const el = target instanceof Element ? target.closest<HTMLElement>("[data-doc]") : null;
  const doc = el?.dataset["doc"];
  return el && doc !== undefined ? { el, doc } : undefined;
}

export const openWikilinks = EditorView.domEventHandlers({
  mousedown: (e, view) => {
    const link = wikilinkAt(e.target);
    if (!link) return false;
    const isEditingIt = activeLines(view.state).has(view.state.doc.lineAt(view.posAtDOM(link.el)).number);
    if (isEditingIt && !(e.metaKey || e.ctrlKey)) return false;
    e.preventDefault();
    location.hash = `docs/${encodeURI(link.doc)}`;
    return true;
  },
});
