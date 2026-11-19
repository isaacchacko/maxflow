import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE } from "../instance";
import { isRecord, stringOr } from "../shared/guards";

const PROJECTS = join(homedir(), ".claude", "projects");
const FETCH_MS = 30_000;

export type Session = { id: string; name: string; running: boolean; sentry: boolean; chatId?: string; transcript?: string };
export type PostedInSlack = { offset: number; sends: Set<string>; threads: Map<string, number>; posted: Set<string> };

export const isSession = (value: unknown): value is Session =>
  isRecord(value) && typeof value["id"] === "string" && typeof value["running"] === "boolean" && typeof value["sentry"] === "boolean";

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch(`${BASE}/api/sessions`, { signal: AbortSignal.timeout(FETCH_MS) });
  const sessions: unknown = await res.json();
  return Array.isArray(sessions) ? sessions.filter(isSession) : [];
}

function transcriptPath(session: Session) {
  if (session.transcript !== undefined) return session.transcript;
  if (session.chatId === undefined || session.chatId === "") return;
  const found = new Bun.Glob(`*/${session.chatId}.jsonl`).scanSync(PROJECTS).next();
  return found.done === true ? undefined : join(PROJECTS, found.value);
}

function transcriptEntry(line: string): Record<string, unknown> | undefined {
  if (!line.includes("slack_send_message") && !line.includes("message_context")) return;
  try {
    const entry: unknown = JSON.parse(line);
    return isRecord(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

const toolResultText = (content: unknown) =>
  Array.isArray(content) ? content.map((part: unknown) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : "")).join("") : stringOr(content);

function noteSlackSend(memo: PostedInSlack, part: Record<string, unknown>) {
  const id = part["id"];
  if (typeof id === "string" && part["type"] === "tool_use" && String(part["name"]).endsWith("slack_send_message")) memo.sends.add(id);
}

function recordContentPart(memo: PostedInSlack, part: unknown, at: number) {
  if (!isRecord(part)) return;
  noteSlackSend(memo, part);
  const toolUseId = part["tool_use_id"];
  if (typeof toolUseId !== "string" || part["type"] !== "tool_result" || !memo.sends.delete(toolUseId)) return;
  const text = toolResultText(part["content"]);
  const sent = /"message_ts":"([\d.]+)","channel_id":"(\w+)"/.exec(text);
  if (!sent) return;
  const [, messageTs = "", channel = ""] = sent;
  const target = `${channel}/${/thread_ts=([\d.]+)/.exec(text)?.[1] ?? messageTs}`;
  memo.posted.add(messageTs);
  memo.threads.set(target, Math.max(at, memo.threads.get(target) ?? 0));
}

function entryTime(entry: Record<string, unknown>) {
  const timestamp = entry["timestamp"];
  const parsed = Date.parse(typeof timestamp === "string" ? timestamp : "");
  return parsed === 0 || Number.isNaN(parsed) ? Date.now() : parsed;
}

function recordTranscriptLine(memo: PostedInSlack, line: string) {
  const entry = transcriptEntry(line);
  if (!entry) return;
  const at = entryTime(entry);
  const message = entry["message"];
  const content: unknown[] = isRecord(message) && Array.isArray(message["content"]) ? message["content"] : [];
  for (const part of content) recordContentPart(memo, part, at);
}

const scanned = new Map<string, PostedInSlack>();
function memoFor(path: string) {
  const known = scanned.get(path);
  if (known) return known;
  const memo: PostedInSlack = { offset: 0, sends: new Set(), threads: new Map(), posted: new Set() };
  scanned.set(path, memo);
  return memo;
}

export function postedInSlackBy(session: Session) {
  const path = transcriptPath(session);
  if (path === undefined || !existsSync(path)) return;
  const memo = memoFor(path);
  const unread = readFileSync(path).subarray(memo.offset);
  const end = unread.lastIndexOf(10) + 1;
  memo.offset += end;
  for (const line of unread.subarray(0, end).toString().split("\n")) recordTranscriptLine(memo, line);
  return memo;
}
