import { setOption } from "./tmux";
import type { Session } from "./sessions";
import { patch } from "./patch";

export function setTranscript(s: Session, path: string) {
  if (!path.endsWith(".jsonl") || path === s.transcript) return;
  patch(s, { transcript: path });
  setOption(s.id, "@mf-transcript", path);
}
