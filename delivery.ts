import { isStamped } from "./shared/legacy-maxflow";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stateDirectory } from "./state";
import { unsentCount } from "./unsent";
import { paste, pressEnter, tmuxAsync, tmuxName } from "./tmux";
import { type Session, chatOf, isAgent, isSentry } from "./sessions";
import { VERIFIED } from "./intro";
import { inputBox, resumeAgent, saveInbox, wake } from "./lifecycle";
import { squash } from "./threads";
import { transcriptTail } from "./background";
import { patch } from "./patch";
import { isFilled, isRecord, stringOr } from "./shared/guards";

export const DRAFTS = stateDirectory("drafts");
const hasInbox = (s: Session) => s.inbox.length > 0;
function didRevive(s: Session) {
  const chat = chatOf(s);
  if (!isFilled(chat)) return false;
  console.log(`${s.id}: claude isn't running in its pane; resuming chat ${chat} to deliver ${s.inbox.length} message(s)`);
  patch(s, { asleep: chat, claudeUp: undefined });
  resumeAgent(s);
  return true;
}

function transcriptWrittenAt(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
export function activeAt(s: Session) {
  const written = isFilled(s.transcript) ? transcriptWrittenAt(s.transcript) : null;
  if (written !== null) return written;
  return isAgent(s) ? (s.claude?.at ?? s.createdAt) : s.lastOutputAt;
}
const draftOf = (text: string) => text.split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n");
const ENTER_RETRIES = 3, PASTE_SEEN_MS = 10 * 60_000;
type Box = { text: string; empty: boolean };
const unsent = (s: Session, box: Box) => (box.empty ? 0 : unsentCount(s.inbox, box.text));
export const BLOCKED_SHOWN_MS = 2 * 60_000, DRAFT_IDLE_MS = 5 * 60_000, DRAFT_IDLE_ISAAC_MS = 60_000;
function saveDraft(s: Session, draft: string | undefined) {
  patch(s, { savedDraft: draft });
  if (isFilled(draft)) {
    mkdirSync(DRAFTS, { recursive: true });
    writeFileSync(`${DRAFTS}/${s.id}.txt`, draft);
  } else rmSync(`${DRAFTS}/${s.id}.txt`, { force: true });
}
function hasDraftWaitedToBeCleared(s: Session, draft: string) {
  const now = Date.now();
  if (s.blockedSince === undefined) patch(s, { blockedSince: now });
  const kept = s.draft?.text === draft ? s.draft : { text: draft, since: now };
  if (kept !== s.draft) patch(s, { draft: kept });
  return now - kept.since >= (s.inbox.some((m) => m.includes(VERIFIED)) ? DRAFT_IDLE_ISAAC_MS : DRAFT_IDLE_MS);
}

const DELIVER_IDLE_MS = 4000;
const QUEUED_BEFORE_PASTE_SLACK_MS = 5000;
type Sent = NonNullable<Session["sending"]>;
type PromptEntry = { type?: unknown; timestamp?: unknown; operation?: unknown; content?: unknown; attachment?: unknown; message?: unknown };
type ContentPart = { type?: unknown; text?: unknown; prompt?: unknown; content?: unknown };
const fieldsOf = (value: unknown): ContentPart => (isRecord(value) ? value : {});
function promptContent(e: PromptEntry): unknown {
  if (e.type === "queue-operation") return e.operation === "enqueue" ? e.content : "";
  if (e.type === "attachment") return fieldsOf(e.attachment).prompt;
  return fieldsOf(e.message).content;
}
function promptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (content.some((p) => p === null || p === undefined)) return undefined;
  return content
    .map(fieldsOf)
    .filter((p) => p.type === "text")
    .map((p) => stringOr(p.text))
    .join("\n");
}
function parsedLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
function isPromptOf(line: string, sent: Sent, head: string) {
  if (!line.includes('"type":"user"') && !line.includes('"type":"queue-operation"') && !line.includes('"type":"queued_command"')) return false;
  const parsed = parsedLine(line);
  if (!isRecord(parsed)) return false;
  const e: PromptEntry = parsed;
  if (Date.parse(stringOr(e.timestamp)) < sent.at - QUEUED_BEFORE_PASTE_SLACK_MS) return false;
  const text = promptText(promptContent(e));
  return text !== undefined && squash(text).includes(head);
}
async function isPrompted(s: Session, sent: Sent, box?: { empty: boolean } | null) {
  if (!isFilled(s.transcript)) return box?.empty === true;
  const head = squash(sent.text).slice(0, 80);
  const tail = await transcriptTail(s.transcript);
  return tail.split("\n").some((line) => isPromptOf(line, sent, head));
}
const CONFIRM_MS = 10_000, RESENDS = 2;
function refreshPeerTurn(s: Session) {
  if (s.peerTurnAt !== undefined && s.peerTurnAt !== 0) patch(s, { peerTurnAt: Date.now() });
}
async function pressEnterAgainUnlessRetriesRanOut(s: Session, box: Box, sent: Sent): Promise<void> {
  if (unsent(s, box) === 0) return;
  if ((s.enterRetries ?? 0) >= ENTER_RETRIES) {
    if (s.enterRetries === ENTER_RETRIES) console.error(`${s.id}: Enter pressed ${ENTER_RETRIES} more times and the pasted message(s) still sit unsent`);
    patch(s, { enterRetries: ENTER_RETRIES + 1 });
    return;
  }
  patch(s, { enterRetries: (s.enterRetries ?? 0) + 1 });
  refreshPeerTurn(s);
  await pressEnter(tmuxName(s.id));
  patch(sent, { at: Date.now() });
}
function resendOrDrop(s: Session, sent: Sent) {
  const resends = (s.resends ?? 0) + 1;
  patch(s, { sending: undefined, resends });
  if (resends > RESENDS) {
    console.error(`${s.id}: ${sent.count} message(s) never became a prompt after ${RESENDS} resends; dropped: ${sent.text.slice(0, 120)}`);
    s.inbox.splice(0, sent.count);
    patch(s, { resends: undefined });
  }
  saveInbox(s);
}
async function isPasteStillUnconfirmed(s: Session, sent: Sent) {
  const box = Date.now() - sent.at < CONFIRM_MS && isFilled(s.transcript) ? undefined : await inputBox(s);
  if (await isPrompted(s, sent, box)) {
    s.inbox.splice(0, sent.count);
    patch(s, { sending: undefined, resends: undefined });
    saveInbox(s);
    return false;
  }
  if (!box || Date.now() - sent.at < CONFIRM_MS) return true;
  if (!box.empty) {
    await pressEnterAgainUnlessRetriesRanOut(s, box, sent);
    return true;
  }
  resendOrDrop(s, sent);
  return false;
}

async function didPressEnterOnLeftoverPaste(s: Session, box: Box) {
  const left = (s.enterRetries ?? 0) < ENTER_RETRIES ? unsent(s, box) : 0;
  if (left === 0) return false;
  console.log(`${s.id}: ${left} message(s) sat pasted in the prompt unsent; pressing Enter`);
  patch(s, { enterRetries: (s.enterRetries ?? 0) + 1, sending: { count: left, text: s.inbox.slice(0, left).join("\n"), at: Date.now() } });
  saveInbox(s);
  patch(s, { pastedAt: Date.now() });
  refreshPeerTurn(s);
  await pressEnter(tmuxName(s.id));
  return true;
}
async function didTypeBackSavedDraft(s: Session, box: Box) {
  const draft = s.savedDraft;
  if (!isFilled(draft) || hasInbox(s) || !box.empty || s.claude?.state !== "idle" || s.claude.at <= (s.pastedAt ?? 0)) return false;
  await paste(tmuxName(s.id), draft);
  saveDraft(s, undefined);
  return true;
}
async function didClearHisDraft(s: Session, box: Box) {
  const isCollapsedPasteOrImage = /\[(Pasted text|Image) #\d+/.test(box.text);
  if (isCollapsedPasteOrImage && s.blockedSince === undefined) patch(s, { blockedSince: Date.now() });
  if (isCollapsedPasteOrImage || isStamped(box.text) || !hasDraftWaitedToBeCleared(s, draftOf(box.text))) return false;
  const draft = draftOf(box.text);
  await tmuxAsync("send-keys", "-t", tmuxName(s.id), "C-c");
  await Bun.sleep(300);
  if ((await inputBox(s))?.empty !== true) return false;
  saveDraft(s, isFilled(s.savedDraft) ? `${s.savedDraft}\n${draft}` : draft);
  return true;
}
async function pasteInbox(s: Session) {
  patch(s, { blockedSince: undefined, draft: undefined });
  const text = s.inbox.join("\n");
  patch(s, { sending: { count: s.inbox.length, text, at: Date.now() } });
  saveInbox(s);
  patch(s, { peerTurnAt: text.includes(VERIFIED) ? undefined : Date.now(), pastedAt: Date.now(), enterRetries: 0 });
  await paste(tmuxName(s.id), text);
  await Bun.sleep(150 + Math.min(1500, text.length / 5));
  await pressEnter(tmuxName(s.id));
}
const isNothingToRead = (s: Session) => !hasInbox(s) && !isFilled(s.savedDraft) && Date.now() - (s.pastedAt ?? 0) >= PASTE_SEEN_MS;
async function isHeldBeforeReadingTheBox(s: Session) {
  if (hasInbox(s) && (s.archived === true || isFilled(s.asleep)) && !isSentry(s)) {
    wake(s);
    return true;
  }
  if (hasInbox(s) && s.claudeUp === false && !isSentry(s) && didRevive(s)) return true;
  if (s.sending && (await isPasteStillUnconfirmed(s, s.sending))) return true;
  return Date.now() - activeAt(s) < DELIVER_IDLE_MS || isNothingToRead(s);
}
export async function deliver(s: Session) {
  if (s.exitCode !== null || (await isHeldBeforeReadingTheBox(s))) return;
  const box = await inputBox(s);
  if (!box || (await didPressEnterOnLeftoverPaste(s, box)) || (await didTypeBackSavedDraft(s, box))) return;
  if (!hasInbox(s)) {
    patch(s, { blockedSince: undefined, draft: undefined });
    return;
  }
  if (!box.empty && !(await didClearHisDraft(s, box))) return;
  await pasteInbox(s);
}
