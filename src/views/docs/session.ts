import { Annotation, ChangeSet } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { loadDoc, saveDoc } from "./api";

export type SaveStatus = "saved" | "saving" | "unsaved" | "merged" | "updated" | "offline";

const SAVE_AFTER_MS = 600;
const fromServer = Annotation.define<boolean>();

const normalized = (text: string) => text.replaceAll("\r\n", "\n");

export function diff(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return ChangeSet.of({ from: start, to: before.length - end, insert: after.slice(start, after.length - end) }, before.length);
}

// constraint: CodeMirror counts every line break as one character, so the base is kept with \n breaks to line up with its positions.
export class DocSession {
  private base: { text: string; version: string };
  private pending: ChangeSet;
  private sentAfter: ChangeSet | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  view: EditorView | undefined;

  constructor(
    readonly path: string,
    text: string,
    version: string,
    readonly report: (status: SaveStatus) => void,
  ) {
    this.base = { text: normalized(text), version };
    this.pending = ChangeSet.empty(this.base.text.length);
  }

  onUpdate(u: ViewUpdate) {
    const local = u.transactions.filter((tr) => tr.docChanged && tr.annotation(fromServer) !== true);
    if (local.length === 0) return;
    for (const tr of local) {
      this.pending = this.pending.compose(tr.changes);
      this.sentAfter = this.sentAfter?.compose(tr.changes);
    }
    this.report("unsaved");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.save();
    }, SAVE_AFTER_MS);
  }

  async save() {
    const view = this.view;
    if (!view || this.sentAfter !== undefined || this.pending.empty) return;
    this.sentAfter = ChangeSet.empty(view.state.doc.length);
    const sent = view.state.doc.toString();
    this.report("saving");
    try {
      const saved = await saveDoc(this.path, view.state.sliceDoc(), this.base.version);
      if (saved.kind === "saved") this.acknowledge(sent, saved.version);
      else this.merge(normalized(saved.text), saved.version, "merged");
    } catch {
      this.sentAfter = undefined;
      this.report("offline");
      return;
    }
    this.sentAfter = undefined;
    if (this.hasUnsaved()) await this.save();
  }

  private hasUnsaved() {
    return !this.pending.empty;
  }

  private isSaving() {
    return this.sentAfter !== undefined;
  }

  private acknowledge(sent: string, version: string) {
    this.base = { text: sent, version };
    this.pending = this.sentAfter ?? ChangeSet.empty(sent.length);
    this.report(this.pending.empty ? "saved" : "unsaved");
  }

  private merge(theirs: string, version: string, status: SaveStatus) {
    const view = this.view;
    if (!view) return;
    const fromBase = diff(this.base.text, theirs);
    view.dispatch({ changes: fromBase.map(this.pending), annotations: fromServer.of(true) });
    this.pending = this.pending.map(fromBase, true);
    this.base = { text: theirs, version };
    this.report(status);
  }

  async refresh() {
    if (this.isSaving() || this.hasUnsaved()) return;
    const doc = await loadDoc(this.path);
    if (doc.version === this.base.version || this.isSaving() || this.hasUnsaved()) return;
    this.merge(normalized(doc.text), doc.version, "updated");
  }

  dispose() {
    clearTimeout(this.timer);
    if (!this.pending.empty) void this.save();
  }
}
