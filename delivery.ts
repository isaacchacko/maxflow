import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stateDirectory } from "./state";
import { unsentCount } from "./unsent";
import { paste, pressEnter, tmuxAsync, tmuxName } from "./tmux";
import { type Session, chatOf, isAgent, isSentry } from "./sessions";
import { VERIFIED } from "./intro";
import { inputBox, resumeAgent, saveInbox, wake } from "./lifecycle";
import { squash } from "./threads";

// Drafts cleared out of the way before a restart still go back once their turn ends.
export const DRAFTS = stateDirectory("drafts");
// A message for an agent whose claude isn't running and wasn't stopped by us (killed, crashed, or the asleep mark lost) resumes its chat
// the way a wake does; false with no chat to resume.
function revive(s: Session) {
  const chat = chatOf(s);
  if (!chat) return false;
  console.log(`${s.id}: claude isn't running in its pane; resuming chat ${chat} to deliver ${s.inbox.length} message(s)`);
  s.asleep = chat;
  s.claudeUp = undefined;
  resumeAgent(s);
  return true;
}

// A claude's TUI redraws nonstop, so for an agent its last transcript write is what counts as activity.
export function activeAt(s: Session) {
  if (s.transcript) {
    try {
      return statSync(s.transcript).mtimeMs;
    } catch {}
  }
  return isAgent(s) ? (s.claude?.at ?? s.createdAt) : s.lastOutputAt;
}
// The draft as typed, near enough: claude indents each line after the first by two spaces (a wrapped line comes back as two).
const draftOf = (text: string) => text.split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n");
// A message the inbox pasted whose Enter was lost (it landed while claude was still taking the paste in) sits in the box unsent,
// and keeps every later message from being delivered: how many inbox messages the box holds that way (see unsentCount).
const ENTER_RETRIES = 3, PASTE_SEEN_MS = 10 * 60_000;
const unsent = (s: Session, box: { text: string; empty: boolean }) => (box.empty ? 0 : unsentCount(s.inbox, box.text));
// Messages behind the user's own draft show as blocked after 2 minutes. A draft unchanged for 5 (1 for his own request relayed by
// the funnel) is cleared with Ctrl+C, which empties a non-empty prompt, the messages go in, and the draft is typed back without Enter
// once that turn ends.
export const BLOCKED_SHOWN_MS = 2 * 60_000, DRAFT_IDLE_MS = 5 * 60_000, DRAFT_IDLE_ISAAC_MS = 60_000;
function saveDraft(s: Session, draft: string | undefined) {
  s.savedDraft = draft;
  if (draft) mkdirSync(DRAFTS, { recursive: true }), writeFileSync(`${DRAFTS}/${s.id}.txt`, draft);
  else rmSync(`${DRAFTS}/${s.id}.txt`, { force: true });
}
// A message stuck behind a draft, and how long the draft has sat unchanged; true once it has waited long enough to clear.
function behindDraft(s: Session, draft: string) {
  const now = Date.now();
  s.blockedSince ??= now;
  if (s.draft?.text !== draft) s.draft = { text: draft, since: now };
  return now - s.draft.since >= (s.inbox.some((m) => m.includes(VERIFIED)) ? DRAFT_IDLE_ISAAC_MS : DRAFT_IDLE_MS);
}

// Notifications wait until the agent is idle at its prompt, so they never land mid-turn or in a permission dialog.
// A pass awaits tmux, so one still running skips the next tick instead of delivering the same inbox twice.
const DELIVER_IDLE_MS = 4000;
// Whether the transcript has the pasted text as a prompt since it was pasted. With no transcript known yet, an emptied box will do.
async function prompted(s: Session, sent: NonNullable<Session["sending"]>, box?: { empty: boolean } | null) {
  if (!s.transcript) return !!box?.empty;
  const head = squash(sent.text).slice(0, 80);
  // An explicit start: Bun's slice(-n) on a file shorter than n does not return the whole file.
  const file = Bun.file(s.transcript);
  const tail = await file.slice(Math.max(0, file.size - 2_000_000)).text().catch(() => "");
  // Sent while claude works, it is queued rather than prompted: a queue-operation enqueue, then a queued_command attachment the turn
  // takes in, and never a user line of its own. Queued is delivered.
  return tail.split("\n").some((line) => {
    if (!line.includes('"type":"user"') && !line.includes('"type":"queue-operation"') && !line.includes('"type":"queued_command"')) return false;
    try {
      const e = JSON.parse(line);
      if (Date.parse(e.timestamp) < sent.at - 5000) return false;
      const c = e.type === "queue-operation" ? (e.operation === "enqueue" ? e.content : "") : e.type === "attachment" ? e.attachment?.prompt : e.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
      return squash(text).includes(head);
    } catch {
      return false;
    }
  });
}
// A paste is delivered once claude has it as a prompt, and only then leaves the inbox. Until that, and for CONFIRM_MS after the paste,
// the session waits; then an Enter that didn't take is pressed again, and a paste that left the box without becoming a prompt is
// sent again (twice at most, then dropped and logged). True while the paste is still unconfirmed, so nothing else is typed.
const CONFIRM_MS = 10_000, RESENDS = 2;
async function confirmSending(s: Session) {
  const sent = s.sending!;
  const box = Date.now() - sent.at < CONFIRM_MS && s.transcript ? undefined : await inputBox(s);
  if (await prompted(s, sent, box)) {
    s.inbox.splice(0, sent.count);
    s.sending = s.resends = undefined;
    saveInbox(s);
    return false;
  }
  if (Date.now() - sent.at < CONFIRM_MS || !box) return true;
  if (!box.empty) {
    if (!unsent(s, box)) return true;
    if ((s.enterRetries ?? 0) >= ENTER_RETRIES) {
      if (s.enterRetries === ENTER_RETRIES) console.error(`${s.id}: Enter pressed ${ENTER_RETRIES} more times and the pasted message(s) still sit unsent`);
      s.enterRetries = ENTER_RETRIES + 1;
      return true;
    }
    s.enterRetries = (s.enterRetries ?? 0) + 1;
    if (s.peerTurnAt) s.peerTurnAt = Date.now();
    await pressEnter(tmuxName(s.id));
    sent.at = Date.now();
    return true;
  }
  s.sending = undefined;
  s.resends = (s.resends ?? 0) + 1;
  if (s.resends > RESENDS) {
    console.error(`${s.id}: ${sent.count} message(s) never became a prompt after ${RESENDS} resends; dropped: ${sent.text.slice(0, 120)}`);
    s.inbox.splice(0, sent.count);
    s.resends = undefined;
  }
  saveInbox(s);
  return false;
}

export async function deliver(s: Session) {
  if (s.exitCode !== null) return;
  // A stopped claude has no prompt to deliver to, so a queued message that finds one asleep resumes it.
  if (s.inbox.length && (s.archived || s.asleep) && !isSentry(s)) return wake(s);
  if (s.inbox.length && s.claudeUp === false && !isSentry(s) && revive(s)) return;
  if (s.sending && (await confirmSending(s))) return;
  if (Date.now() - activeAt(s) < DELIVER_IDLE_MS) return;
  // Only sessions with a message pending or a recent paste are read, so idle ones cost no capture each second.
  if (!s.inbox.length && !s.savedDraft && Date.now() - (s.pastedAt ?? 0) >= PASTE_SEEN_MS) return;
  const box = await inputBox(s);
  if (!box) return;
  // One of ours left unsent from before (a paste the server restarted on, so it has no record of sending it): Enter again, and
  // confirm it like a fresh paste, so the messages leave the inbox once they are a prompt instead of being pasted a second time.
  const left = (s.enterRetries ?? 0) < ENTER_RETRIES ? unsent(s, box) : 0;
  if (left) {
    console.log(`${s.id}: ${left} message(s) sat pasted in the prompt unsent; pressing Enter`);
    s.enterRetries = (s.enterRetries ?? 0) + 1;
    s.sending = { count: left, text: s.inbox.slice(0, left).join("\n"), at: Date.now() };
    saveInbox(s);
    s.pastedAt = Date.now();
    if (s.peerTurnAt) s.peerTurnAt = Date.now();
    await pressEnter(tmuxName(s.id));
    return;
  }
  // The turn our messages started has ended: the user's draft goes back where he left it, unsubmitted.
  if (s.savedDraft && !s.inbox.length && box.empty && s.claude?.state === "idle" && s.claude.at > (s.pastedAt ?? 0)) {
    await paste(tmuxName(s.id), s.savedDraft);
    return saveDraft(s, undefined);
  }
  if (!s.inbox.length) return void (s.blockedSince = s.draft = undefined);
  if (!box.empty) {
    // Our own message whose Enter retries ran out is no draft of his to clear. Nor is one holding a collapsed paste or image:
    // the prompt shows only "[Pasted text #N +k lines]", so clearing it would lose what he pasted; it stays blocked for him.
    const collapsed = /\[(Pasted text|Image) #\d+/.test(box.text);
    if (collapsed) s.blockedSince ??= Date.now();
    if (box.text.startsWith("[maxflow") || collapsed || !behindDraft(s, draftOf(box.text))) return;
    const draft = draftOf(box.text);
    await tmuxAsync("send-keys", "-t", tmuxName(s.id), "C-c");
    await Bun.sleep(300);
    if (!(await inputBox(s))?.empty) return;
    saveDraft(s, s.savedDraft ? `${s.savedDraft}\n${draft}` : draft);
  }
  s.blockedSince = s.draft = undefined;
  const text = s.inbox.join("\n");
  s.sending = { count: s.inbox.length, text, at: Date.now() };
  saveInbox(s);
  s.peerTurnAt = text.includes(VERIFIED) ? undefined : Date.now();
  s.pastedAt = Date.now();
  s.enterRetries = 0;
  await paste(tmuxName(s.id), text);
  // A longer paste takes claude longer to take in before Enter submits it.
  await Bun.sleep(150 + Math.min(1500, text.length / 5));
  await pressEnter(tmuxName(s.id));
}

