import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isRecord, stringOr } from "../shared/guards";

const NEWLINE = 10;
const RELAYED_BY_A_SENDER = /^\[(yarn|maxflow|isovim|from )/;
const TYPED_BY_SERVER_HOOK_OR_HARNESS = /^(<|\[(yarn|maxflow|isovim|from |Request interrupted))|^This session is being continued/;
const PASTED = /<pasted_content id="(\w+)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;

export type TranscriptEntry = Record<string, unknown>;

export function fullLinesAppendedSince(path: string, offset: number) {
  const size = statSync(path).size;
  const from = size < offset ? 0 : offset;
  const buf = Buffer.alloc(size - from);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, buf.length, from);
  closeSync(fd);
  const end = buf.lastIndexOf(NEWLINE) + 1;
  return { offset: from + end, lines: buf.subarray(0, end).toString("utf8").split("\n").filter((line) => line !== "") };
}

export function lastLinesWithin(path: string, bytes: number) {
  const size = statSync(path).size;
  const buf = Buffer.alloc(Math.min(size, bytes));
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, buf.length, size - buf.length);
  closeSync(fd);
  return buf.toString("utf8").split("\n");
}

export function parseEntry(line: string): TranscriptEntry | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    return isRecord(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function textOf(entry: TranscriptEntry) {
  const content = isRecord(entry["message"]) ? entry["message"]["content"] : undefined;
  if (typeof content === "string") return content;
  const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
  return blocks
    .filter((c) => c["type"] === "text")
    .map((c) => stringOr(c["text"]))
    .join("\n");
}

export function usersOwnWordsUnlessStampedBySender(entry: TranscriptEntry): string | null {
  if (entry["isMeta"] === true || entry["isCompactSummary"] === true || entry["isSidechain"] === true) return null;
  const text = textOf(entry)
    .replaceAll(PASTED, (_match, _id: string, inner: string) => (RELAYED_BY_A_SENDER.test(inner) ? "" : inner))
    .trim();
  if (text === "" || TYPED_BY_SERVER_HOOK_OR_HARNESS.test(text)) return null;
  return text;
}

export function lastReply(lines: string[]) {
  const newestFirst = lines.toReversed().filter((l) => l.includes('"assistant"'));
  for (const line of newestFirst) {
    const entry = parseEntry(line);
    const text = entry?.["type"] === "assistant" && entry["isSidechain"] !== true ? textOf(entry).trim() : "";
    if (text !== "") return text;
  }
  return "";
}
