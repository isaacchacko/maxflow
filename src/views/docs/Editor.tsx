import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useState } from "react";
import { useInterval } from "@/lib/effects";
import type { Doc } from "./api";
import { extensionsFor } from "./extensions";
import { DocSession, type SaveStatus } from "./session";
import { didCommentOnSelection } from "./threads";

const REMOTE_CHECK_MS = 3000;
const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Editing…",
  merged: "Merged an agent's edit with yours",
  updated: "Updated by an agent",
  offline: "Not saved: the server didn't answer",
};

export function useDocEditor(doc: Doc) {
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [session, setSession] = useState<DocSession | undefined>();
  const mount = useCallback(
    (parent: HTMLDivElement | null) => {
      if (!parent) return;
      const s = new DocSession(doc.path, doc.text, doc.version, setStatus);
      const view = new EditorView({ parent, state: EditorState.create({ doc: doc.text, extensions: extensionsFor(s, doc.text) }) });
      s.view = view;
      setSession(s);
      return () => {
        s.dispose();
        view.destroy();
        s.view = undefined;
        setSession(undefined);
      };
    },
    [doc],
  );
  useInterval(async () => session?.refresh(), REMOTE_CHECK_MS);
  const comment = () => {
    if (session?.view) didCommentOnSelection(session.view);
  };
  return { mount, comment, status: STATUS_TEXT[status], isWarning: status === "offline" };
}
