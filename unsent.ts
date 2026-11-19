// How many of the inbox's first messages claude's input box holds unsent, or 0 when the box holds none of ours.
// It is read from the box and the inbox alone, both of which outlive a server restart (the inbox is kept in tmux), so a paste
// whose Enter the old server never pressed or never retried is found again by the new one (router 17656f41 sat 12 minutes on
// one after the 02:10Z deploy on 2026-11-19).
// A short paste shows as typed, starting with the server's stamp. A long one shows collapsed, as "[Pasted text #N +k lines]",
// where k is its newline count: ours when it matches the newlines of the first n inbox messages joined as the server pasted them.
export function unsentCount(inbox: string[], box: string) {
  const collapsed = box.match(/^\[Pasted text #\d+ \+(\d+) lines?\]$/);
  if (collapsed) {
    for (let n = 1, lines = 0; n <= inbox.length; n++) {
      lines += (inbox[n - 1].match(/\n/g)?.length ?? 0) + (n > 1 ? 1 : 0);
      if (lines === Number(collapsed[1])) return n;
    }
    return 0;
  }
  if (!box.trimStart().startsWith("[maxflow")) return 0;
  // Wrapping splits the box's lines wherever the pane is narrow, so the text is compared with no whitespace at all.
  const bare = (t: string) => t.replace(/\s+/g, "");
  const shown = bare(box);
  for (let n = inbox.length; n > 0; n--) if (bare(inbox.slice(0, n).join("\n")) === shown) return n;
  return inbox.length ? 1 : 0;
}
