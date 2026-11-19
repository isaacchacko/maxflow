const COLLAPSED_PASTE = /^\[Pasted text #\d+ \+(\d+) lines?\]$/;

const withoutWhitespace = (text: string) => text.replaceAll(/\s+/g, "");

const newlineCount = (text: string) => text.match(/\n/g)?.length ?? 0;

function messagesInCollapsedPaste(inbox: string[], pastedNewlines: number) {
  let newlines = 0;
  for (const [index, message] of inbox.entries()) {
    newlines += newlineCount(message) + (index > 0 ? 1 : 0);
    if (newlines === pastedNewlines) return index + 1;
  }
  return 0;
}

function messagesTypedInBox(inbox: string[], box: string) {
  if (!box.trimStart().startsWith("[maxflow")) return 0;
  const shown = withoutWhitespace(box);
  for (let n = inbox.length; n > 0; n--) if (withoutWhitespace(inbox.slice(0, n).join("\n")) === shown) return n;
  return inbox.length > 0 ? 1 : 0;
}

export function unsentCount(inbox: string[], box: string) {
  const collapsed = COLLAPSED_PASTE.exec(box);
  if (collapsed) return messagesInCollapsedPaste(inbox, Number(collapsed[1]));
  return messagesTypedInBox(inbox, box);
}
