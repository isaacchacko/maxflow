const KEPT = 200;
export const squash = (text: string) => text.replaceAll(/<\/?pasted_content[^>]*>/g, "").replaceAll(/\s+/g, " ").trim();
const KEPT_MS = 24 * 3_600_000;
const said: { text: string; at: number }[] = [];

// constraint: only routes that passed his passkey check record here, and it lives in memory, so tmux send-keys and state-file writes can't add to it
export function recordIsaacSaid(text: string) {
  const words = squash(text);
  if (words === "") return;
  said.push({ text: words, at: Date.now() });
  said.splice(0, Math.max(0, said.length - KEPT));
}

export const isaacSaidLately = () => said.filter((s) => Date.now() - s.at < KEPT_MS).map((s) => s.text);

const typing = new Map<string, string>();
const BACKSPACES = new Set(["\u{8}", "\u{7F}"]);

export function recordIsaacTyped(session: string, keys: string) {
  let line = typing.get(session) ?? "";
  for (const key of keys) {
    if (key === "\r" || key === "\n") {
      recordIsaacSaid(line);
      line = "";
    } else if (BACKSPACES.has(key)) line = line.slice(0, -1);
    else if (key >= " ") line += key;
  }
  typing.set(session, line);
}
