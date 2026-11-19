import { backgroundShells } from "./background";
import { publish } from "./bus";
import { type ClaudeState, type Session, isAgent, isSentry, sessions } from "./sessions";
import { dispatch, inputBox, setArchived, setClaudeState, setWait, stopAgent, wake } from "./lifecycle";
import { tellDone } from "./waits";

// A claude's hook said its state changed (or the resync below found it had): a waiting agent sleeps once its turn ends, a turn the
// user starts clears done, and a finished turn gets afterTurn.
export function claudeStateChanged(s: Session, state: ClaudeState | "gone") {
  const was = s.claude?.state;
  setClaudeState(s, state);
  // A waiting agent sleeps once its turn ends, unless messages wait to be delivered.
  // A done agent stays awake so the user can read its last reply and answer it. A turn the user starts means new work, so it isn't
  // done; a turn started by a peer's message is a small exchange, and the agent is still done after it unless it declares otherwise.
  if (s.wait?.kind === "done" && state === "working" && was !== "working" && Date.now() - (s.peerTurnAt ?? 0) > 10_000) setWait(s);
  // Only a finished turn puts it back to sleep, not the idle of a claude just resumed by a wake.
  // It sleeps a moment after the Stop, not at once: a Stop hook can block the stop (the questions hook does), and the turn then goes on.
  else if (s.wait && s.wait.kind !== "done" && state === "idle" && (was === "working" || was === "waiting") && !s.archived && !s.inbox.length) {
    const at = s.claude?.at;
    setTimeout(() => {
      if (!s.wait || s.wait.kind === "done" || s.archived || s.inbox.length || s.claude?.state !== "idle" || s.claude.at !== at) return;
      setWait(s, { ...s.wait, awake: false });
      setArchived(s, true);
    }, SLEEP_AFTER_STOP_MS);
  }
  else if (state === "idle" && s.archived) stopAgent(s);
  if (state === "idle" && (was === "working" || was === "waiting") && isAgent(s) && !isSentry(s)) afterTurn(s);
  // Still working once archived (a turn that went on anyway): it is awake on the same wait, which only the awaited event ends.
  if (s.wait && state === "working" && s.archived) wake(s);
}

// A Stop or prompt the server never heard (it was down or restarting when the hook fired) would leave an agent "working" with no
// wait, or idle with no wait, forever. At boot and every 30s each agent's transcript is the truth: a turn is over once its last
// turn_duration entry has no user, assistant or api-request entry after it. A hook state still "working" for a turn over a minute
// ago is a missed Stop, handled as one; an agent idle with no wait whose turn ended 5 minutes ago, with an empty prompt box and no
// background shell, gets the auto done it would have had.
export const RESYNC_MS = 30_000, IDLE_DONE_MS = 5 * 60_000;
async function turnOver(s: Session) {
  if (!s.transcript) return null;
  const file = Bun.file(s.transcript);
  const tail = await file.slice(Math.max(0, file.size - 500_000)).text().catch(() => "");
  const end = tail.lastIndexOf('"subtype":"turn_duration"');
  if (end < 0) return null;
  const after = tail.slice(tail.indexOf("\n", end) + 1);
  return /"type":"(user|assistant|api-request)"/.test(after) ? null : { at: file.lastModified };
}
export async function resync() {
  for (const s of sessions.values()) {
    if (!isAgent(s) || isSentry(s) || s.exitCode !== null || s.asleep || s.claudeUp === false || s.inbox.length) continue;
    const over = await turnOver(s);
    if (!over) continue;
    if (s.claude?.state === "working" && Date.now() - over.at > 60_000) {
      publish(`claude-resync/${s.id}`, { session: s.id, was: "working", now: "idle" });
      claudeStateChanged(s, "idle");
    } else if (s.claude?.state !== "working" && s.claude?.state !== "waiting" && !s.wait && !s.archived && Date.now() - over.at > IDLE_DONE_MS && (await inputBox(s))?.empty) {
      const { background } = await turnEnd(s);
      if (background || s.wait) continue;
      setWait(s, { kind: "done", ref: "", at: Date.now(), auto: true });
      publish(`claude-resync/${s.id}`, { session: s.id, idle: true });
      tellDone(s);
    }
  }
}

// After a claude's turn ends, once a Stop hook had its chance to block the stop: a turn the Mac's sleep cut off is carried on once
// it is awake, and a turn that ended with no wait declared is done, as if the agent ran `wait done`, unless a background shell
// it started is still running (that shell's exit re-invokes it).
function afterTurn(s: Session) {
  // checkClaude can clear s.claude between the Stop hook and here.
  const at = s.claude?.at;
  if (at === undefined) return;
  setTimeout(async () => {
    if (s.claude?.state !== "idle" || s.claude.at !== at || s.exitCode !== null || s.inbox.length) return;
    const end = await turnEnd(s);
    if (end.cutOff && end.cutOff !== s.cutOff) return void ((s.cutOff = end.cutOff), carryOn(s, at));
    // A turn ended done is a finish: anyone who started waiting on it during the turn hears now.
    if (s.wait?.kind === "done") return void (setWait(s, { ...s.wait, at: Date.now() }), tellDone(s));
    if (s.wait || s.archived || end.background) return;
    setWait(s, { kind: "done", ref: "", at: Date.now(), auto: true });
    tellDone(s);
  }, SLEEP_AFTER_STOP_MS);
}
// What the end of a transcript says about the turn that just ended: the uuid of its last reply when that is the API error the Mac
// sleeping causes, and whether a background shell started in the last 12h has not reported back.
const SLEEP_CUT = /went to sleep mid-response|while your computer was asleep/;
async function turnEnd(s: Session) {
  if (!s.transcript) return { background: false };
  const file = Bun.file(s.transcript);
  const tail = await file.slice(Math.max(0, file.size - 2_000_000)).text().catch(() => "");
  let cutOff: string | undefined;
  for (const line of tail.split("\n")) {
    if (!line.startsWith('{"') || !line.includes('"type":"assistant"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== "assistant") continue;
      const text = (e.message?.content ?? []).map((p: any) => p.text ?? "").join(" ");
      cutOff = e.isApiErrorMessage && SLEEP_CUT.test(text) ? e.uuid : undefined;
    } catch {}
  }
  return { cutOff, background: backgroundShells(tail).size > 0 };
}
// The Mac asleep stops this loop too, so a gap in it is a sleep; awakeSince is when the last one ended.
let tickAt = Date.now(), awakeSince = 0;
setInterval(() => {
  if (Date.now() - tickAt > 30_000) awakeSince = Date.now();
  tickAt = Date.now();
}, 5_000);
// Once the Mac has been awake 20s, the cut-off agent is told to carry on, unless something else has started it since.
function carryOn(s: Session, at: number) {
  const check = setInterval(() => {
    if (s.exitCode !== null || s.claude?.at !== at || s.claude?.state !== "idle") return clearInterval(check);
    if (Date.now() - awakeSince < 20_000 || Date.now() - tickAt > 10_000) return;
    clearInterval(check);
    publish(`turn-cut/${s.id}`, { session: s.id, reply: s.cutOff });
    dispatch({ to: [s], target: s.name, text: "[maxflow] your last turn was cut off by the Mac sleeping; carry on" });
  }, 5_000);
}
const SLEEP_AFTER_STOP_MS = 3000;
