import { setOption } from "./tmux";
import type { Session } from "./sessions";

export function setTranscript(s: Session, path: string) {
  if (!path.endsWith(".jsonl") || path === s.transcript) return;
  s.transcript = path;
  s.links = undefined;
  setOption(s.id, "@mf-transcript", path);
}
