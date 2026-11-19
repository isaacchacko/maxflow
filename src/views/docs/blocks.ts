import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

const PARSE_BUDGET_MS = 50;

const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replaceAll(/\*\*|__|`/g, ""));

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return other.source === this.source && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const [head = "", , ...body] = this.source.split("\n");
    const table = document.createElement("table");
    table.className = "cm-md-rendered-table";
    const addRow = (cells: string[], tag: "th" | "td") => {
      const tr = table.insertRow();
      for (const text of cells) {
        const cell = document.createElement(tag);
        cell.textContent = text;
        tr.append(cell);
      }
    };
    addRow(cellsOf(head), "th");
    for (const line of body) addRow(cellsOf(line), "td");
    table.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return table;
  }
  override ignoreEvent() {
    return false;
  }
}

const isEditing = (state: EditorState, from: number, to: number) => state.selection.ranges.some((r) => r.to >= from && r.from <= to);

function frontmatterLines(state: EditorState, out: Range<Decoration>[]) {
  if (state.doc.lines < 2 || state.doc.line(1).text !== "---") return;
  for (let n = 2; n <= state.doc.lines; n++) {
    if (state.doc.line(n).text === "---") {
      for (let k = 1; k <= n; k++) out.push(Decoration.line({ class: "cm-md-frontmatter" }).range(state.doc.line(k).from));
      return;
    }
  }
}

function blockDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  frontmatterLines(state, out);
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name !== "Table" || isEditing(state, node.from, node.to)) return;
      out.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(node.from, node.to), node.from), block: true }).range(node.from, node.to));
    },
  });
  return Decoration.set(out, true);
}

// constraint: CodeMirror takes decorations that replace whole lines (a rendered table) only from a state field, never from a view plugin.
export const renderedBlocks = StateField.define<DecorationSet>({
  create: blockDecorations,
  update: (decorations, tr) => (tr.docChanged || tr.selection !== undefined || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? blockDecorations(tr.state) : decorations),
  provide: (field) => EditorView.decorations.from(field),
});
