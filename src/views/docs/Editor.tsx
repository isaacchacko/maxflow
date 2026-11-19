import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useRef, useState } from "react";
import { useInterval, useLatest } from "@/lib/effects";
import type { Doc } from "./api";
import { extensionsFor } from "./extensions";
import { DocSession, type SaveStatus } from "./session";
import { commentOnSelection } from "./threads";

const REMOTE_CHECK_MS = 3000;
const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Editing…",
  merged: "Merged an agent's edit with yours",
  updated: "Updated by an agent",
  offline: "Not saved: the server didn't answer",
};

export function useDocEditor(doc: Doc, docPaths: string[]) {
  const [status, setStatus] = useState<SaveStatus>("saved");
  const session = useRef<DocSession | undefined>(undefined);
  const paths = useLatest(docPaths);
  const mount = useCallback(
    (parent: HTMLDivElement | null) => {
      if (!parent) return;
      const s = new DocSession(doc.path, doc.text, doc.version, setStatus);
      const view = new EditorView({ parent, state: EditorState.create({ doc: doc.text, extensions: extensionsFor(s, doc.text, () => paths.current) }) });
      s.view = view;
      session.current = s;
      return () => {
        s.dispose();
        view.destroy();
        s.view = undefined;
      };
    },
    [doc, paths],
  );
  useInterval(async () => session.current?.refresh(), REMOTE_CHECK_MS);
  const comment = () => {
    const view = session.current?.view;
    if (view) commentOnSelection(view);
  };
  return { mount, comment, status: STATUS_TEXT[status], isWarning: status === "offline" };
}
