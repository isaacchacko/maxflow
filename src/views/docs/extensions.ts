import { autocompletion, type CompletionContext, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { knownDocPaths, uploadFile } from "./api";
import { renderedBlocks } from "./blocks";
import { livePreview, openWikilinks } from "./livePreview";
import type { DocSession } from "./session";
import { didCommentOnSelection } from "./threads";

function didWrap(view: EditorView, mark: string) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const isWrapped = text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2;
      const insert = isWrapped ? text.slice(mark.length, -mark.length) : `${mark}${text}${mark}`;
      const anchor = range.empty ? range.from + mark.length : range.from;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(anchor, range.empty ? anchor : range.from + insert.length) };
    }),
  );
  return true;
}

function didLink(view: EditorView) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const insert = `[${view.state.sliceDoc(range.from, range.to)}](url)`;
      const urlAt = range.from + insert.length - 4;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(urlAt, urlAt + 3) };
    }),
  );
  return true;
}

function wikilinkCompletions(context: CompletionContext) {
  const typed = context.matchBefore(/\[\[[^\]\n]*/);
  if (!typed) return null;
  const hasClose = context.state.sliceDoc(context.pos, context.pos + 2) === "]]";
  const options = knownDocPaths().map((path) => {
    const label = path.replace(/\.md$/, "");
    return { label, type: "text", apply: hasClose ? label : `${label}]]` };
  });
  return { from: typed.from + 2, options, validFor: /^[^\]\n]*$/ };
}

const safeName = (name: string) => name.replaceAll(/[^\w.-]+/g, "-");

async function embedFiles(view: EditorView, files: File[]) {
  const embeds: string[] = [];
  for (const file of files) {
    const name = `${String(Date.now())}-${safeName(file.name === "" ? "pasted.png" : file.name)}`;
    await uploadFile(`attachments/${name}`, file);
    embeds.push(`![[${name}]]`);
  }
  view.dispatch(view.state.replaceSelection(embeds.join("\n")));
}

function didTakeFiles(list: FileList | undefined | null, view: EditorView) {
  const files = [...(list ?? [])];
  if (files.length === 0) return false;
  void embedFiles(view, files);
  return true;
}

const attachments = EditorView.domEventHandlers({
  paste: (e, view) => didTakeFiles(e.clipboardData?.files, view),
  drop: (e, view) => didTakeFiles(e.dataTransfer?.files, view),
});

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: tags.processingInstruction, color: "var(--muted-foreground)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono, ui-monospace)" },
  { tag: tags.url, color: "var(--muted-foreground)" },
  { tag: tags.quote, color: "var(--muted-foreground)" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "15px", color: "var(--foreground)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit" },
  ".cm-content": { lineHeight: "1.65", padding: "24px 0 40vh", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 2px" },
  ".cm-md-h1": { fontSize: "1.75em", fontWeight: "600", lineHeight: "1.4" },
  ".cm-md-h2": { fontSize: "1.4em", fontWeight: "600" },
  ".cm-md-h3": { fontSize: "1.2em", fontWeight: "600" },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontWeight: "600" },
  ".cm-md-strong": { fontWeight: "600" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through" },
  ".cm-md-code": { fontFamily: "var(--font-mono, ui-monospace)", fontSize: "0.88em", backgroundColor: "var(--muted)", borderRadius: "4px", padding: "1px 3px" },
  ".cm-md-codeblock": { fontFamily: "var(--font-mono, ui-monospace)", fontSize: "0.88em", backgroundColor: "var(--muted)" },
  ".cm-md-table": { fontFamily: "var(--font-mono, ui-monospace)", fontSize: "0.88em" },
  ".cm-md-frontmatter": { fontFamily: "var(--font-mono, ui-monospace)", fontSize: "0.8em", color: "var(--muted-foreground)" },
  ".cm-md-rendered-table": { borderCollapse: "collapse", margin: "8px 0", fontSize: "0.92em", cursor: "text" },
  ".cm-md-rendered-table th, .cm-md-rendered-table td": { border: "1px solid var(--border)", padding: "4px 12px", textAlign: "left" },
  ".cm-md-rendered-table th": { backgroundColor: "var(--muted)", fontWeight: "500" },
  ".cm-md-link, .cm-md-wikilink": { color: "var(--link)", cursor: "pointer" },
  ".cm-md-bullet": { color: "var(--muted-foreground)", padding: "0 4px" },
  ".cm-md-task": { margin: "0 6px 0 0", verticalAlign: "middle" },
  ".cm-md-image": { display: "block", maxWidth: "100%", maxHeight: "24rem", borderRadius: "6px", margin: "6px 0" },
  ".cm-callout": { backgroundColor: "color-mix(in oklab, var(--muted) 70%, transparent)", borderLeft: "3px solid var(--border)", paddingLeft: "12px", fontSize: "0.92em" },
  ".cm-callout-open": { backgroundColor: "color-mix(in oklab, var(--warn-soft) 60%, transparent)", borderLeftColor: "var(--warn)" },
  ".cm-callout-reply": { paddingLeft: "28px" },
  ".cm-callout-header": { display: "inline-flex", gap: "10px", alignItems: "center", fontWeight: "500" },
  ".cm-callout-state": { color: "var(--muted-foreground)", fontWeight: "400", fontSize: "0.9em" },
  ".cm-callout-open .cm-callout-state": { color: "var(--warn)" },
  ".cm-callout-who": { color: "var(--muted-foreground)", fontWeight: "500" },
  ".cm-callout-button": { fontSize: "0.85em", border: "1px solid var(--border)", borderRadius: "6px", padding: "0 6px", backgroundColor: "var(--card)", cursor: "pointer" },
  ".cm-tooltip-autocomplete": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: "8px" },
});

export function extensionsFor(session: DocSession, text: string): Extension[] {
  const didSave = () => {
    void session.save();
    return true;
  };
  return [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(highlight),
    autocompletion({ override: [wikilinkCompletions] }),
    keymap.of([
      { key: "Mod-b", run: (v) => didWrap(v, "**") },
      { key: "Mod-i", run: (v) => didWrap(v, "*") },
      { key: "Mod-k", run: didLink },
      { key: "Mod-Shift-m", run: didCommentOnSelection },
      { key: "Mod-s", run: didSave, preventDefault: true },
      ...completionKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    livePreview(session.path),
    renderedBlocks,
    openWikilinks,
    attachments,
    theme,
    placeholder("Start writing…"),
    ...(text.includes("\r\n") ? [EditorState.lineSeparator.of("\r\n")] : []),
    EditorView.updateListener.of((u) => session.onUpdate(u)),
  ];
}
