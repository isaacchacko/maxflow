import { callerOf } from "./shared/legacy-maxflow";
import { inboxesTable } from "./state";
import { publish } from "./bus";
import { CLI } from "./instance";
import { paste, pressEnter, setOption, tmux, tmuxAsync, tmuxName } from "./tmux";
import { type Session, isAgent, isSentry, sessions } from "./sessions";
import { intro } from "./intro";
import { dispatch, endWait, screen, setArchived, isWaitingOn, wake } from "./lifecycle";
import { declareWait, sayWhyInThreadsHeWaitsIn, untilShell } from "./waits";
import { claudeStateChanged } from "./turns";
import { SENTRY_USES } from "./sentry-uses";
import { describe } from "./world-session";
import { requested } from "./routing";
import { touchFrom } from "./sentry-files";
import { stamp } from "./stamp";
import { setTranscript } from "./transcripts";
import { patch } from "./patch";
import { askForHandoffNote, completeHandoff, noteHandoff, successorOf } from "./handoffs";
import { isFilled } from "./shared/guards";
import { type Body, type Route, firstAnswer, flagOf, isFromTheBrowser, jsonBody, matching, sender, textOf, textsOf } from "./route-kit";

type SessionAct = (req: Request, s: Session, url: URL) => Promise<Response> | Response;
type Typed = { text: string | undefined; isQueuedForAnIdlePrompt: boolean };

const CLAUDE_STATES = ["working", "waiting", "idle", "gone"] as const;
const fromIsaac = (isIsaac: boolean): { source?: "isaac" } => (isIsaac ? { source: "isaac" } : {});
const fromSession = (from: Session | undefined): { from?: Session } => (from ? { from } : {});
const trimmedTextOf = (body: Body) => textOf(body, "text")?.trim() ?? "";

function deliverToAnAgentSayingWhoTypedIt(req: Request, s: Session, text: string, body: Body): Typed | { error: string } {
  const isIsaac = flagOf(body, "isaac") === true;
  const stamped = stamp(req, text, isIsaac);
  if ("error" in stamped) return stamped;
  if (isFilled(stamped.request)) requested(s, stamped.request);
  const from = sender(req);
  const isQueuedForAnIdlePrompt = flagOf(body, "enter") === true && (from !== undefined || isIsaac);
  dispatch({ ...fromSession(from), ...fromIsaac(isIsaac), to: [s], text, ...(isQueuedForAnIdlePrompt ? { deliver: stamped.text } : { typed: true }) });
  return { text: stamped.text, isQueuedForAnIdlePrompt };
}

const typedFor = (req: Request, s: Session, text: string | undefined, body: Body): Typed | { error: string } =>
  isFilled(text) && isAgent(s) ? deliverToAnAgentSayingWhoTypedIt(req, s, text, body) : { text, isQueuedForAnIdlePrompt: false };

// constraint: a plain sentry is a script, not a prompt; text typed into its pane reaches nobody, so the sender has to hear that instead of a silent ok
const nobodyReads = (s: Session) =>
  new Response(
    `${s.name} (${s.id}) isn't an agent: it's a plain process, and nothing reads text sent to it. To stand the sentries down on a PR, run \`${CLI} hold <pr>\`; to reach the agent behind it, notify that agent's session instead.`,
    { status: 409 },
  );

const isTextForAPlainSentry = (s: Session, text: string | undefined) => isFilled(text) && isSentry(s) && !isAgent(s);

async function typeInto(req: Request, s: Session): Promise<Response> {
  const body = await jsonBody(req);
  if (s.exitCode !== null) return new Response("session ended", { status: 409 });
  const text = textOf(body, "text");
  if (isTextForAPlainSentry(s, text)) return nobodyReads(s);
  const typed = typedFor(req, s, text, body);
  if ("error" in typed) return new Response(typed.error, { status: 409 });
  touchFrom(req, s, "write");
  const t = tmuxName(s.id);
  if (!typed.isQueuedForAnIdlePrompt && isFilled(typed.text)) await paste(t, typed.text);
  const keys = textsOf(body, "keys") ?? [];
  if (keys.length > 0) await tmuxAsync("send-keys", "-t", t, ...keys);
  if (!typed.isQueuedForAnIdlePrompt && flagOf(body, "enter") === true) {
    // constraint: a TUI like claude reads text and Enter in one burst as a paste, so Enter goes separately
    await Bun.sleep(isFilled(text) ? 150 : 0);
    await pressEnter(t);
  }
  return Response.json(describe(s));
}

async function hisWordsTypedIntoAnAsleepPane(req: Request, s: Session): Promise<Response> {
  const text = trimmedTextOf(await jsonBody(req));
  if (text === "") return new Response("text required", { status: 400 });
  if (s.exitCode !== null) return new Response("session ended", { status: 409 });
  dispatch({ source: "isaac", to: [s], text });
  return Response.json(describe(s));
}

// constraint: the agent that took over may still ask the one it replaced, so only its messages reach the old id
function recipientAfterHandOffs(req: Request, addressed: Session) {
  const successor = successorOf(addressed);
  return sender(req) === successor ? addressed : successor;
}

async function nativeSendMessageQueuedWhileAsleep(req: Request, addressed: Session): Promise<Response> {
  const s = recipientAfterHandOffs(req, addressed);
  const text = trimmedTextOf(await jsonBody(req));
  const from = sender(req);
  if (text === "" || !from) return new Response("text and a calling session required", { status: 400 });
  const isAsleep = s.exitCode === null && (s.archived === true || isFilled(s.asleep));
  const stamped = stamp(req, text);
  dispatch({ from, to: [s], text, deliver: "error" in stamped ? text : stamped.text, typed: !isAsleep });
  if (isWaitingOn(s, from.id)) endWait(s);
  touchFrom(req, s, "write");
  return Response.json({ queued: isAsleep });
}

async function notify(req: Request, addressed: Session): Promise<Response> {
  const s = recipientAfterHandOffs(req, addressed);
  const body = await jsonBody(req);
  const text = trimmedTextOf(body);
  if (text === "") return new Response("text required", { status: 400 });
  if (!isAgent(s)) return nobodyReads(s);
  const isIsaac = flagOf(body, "isaac") === true;
  const stamped = stamp(req, text, isIsaac);
  if ("error" in stamped) return new Response(stamped.error, { status: 409 });
  if (isFilled(stamped.request)) requested(s, stamped.request);
  dispatch({ ...fromSession(sender(req)), ...fromIsaac(isIsaac), to: [s], text, deliver: stamped.text });
  const isFromTheAwaitedAgent = isWaitingOn(s, callerOf(req));
  if (isFromTheAwaitedAgent) endWait(s);
  touchFrom(req, s, "write");
  return Response.json(describe(s), { status: 202 });
}

async function claudeState(req: Request, s: Session): Promise<Response> {
  const body = await jsonBody(req);
  const asked = textOf(body, "state");
  const state = CLAUDE_STATES.find((x) => x === asked);
  if (state === undefined) return new Response("state must be working, waiting, idle or gone", { status: 400 });
  const transcript = textOf(body, "transcript");
  if (isFilled(transcript)) setTranscript(s, transcript);
  claudeStateChanged(s, state);
  return Response.json(describe(s));
}

function untilShellAskedIn(body: Body) {
  const [desc, cmd, cwd, path, pane] = ["desc", "cmd", "cwd", "path", "pane"].map((key) => textOf(body, key));
  const pid = body["pid"];
  return {
    ...(desc !== undefined && { desc }),
    ...(cmd !== undefined && { cmd }),
    ...(cwd !== undefined && { cwd }),
    ...(path !== undefined && { path }),
    ...(pane !== undefined && { pane }),
    ...(typeof pid === "number" && { pid }),
  };
}

function waitTargetStartingAnUntilShellFirst(s: Session, kind: string, ref: string | undefined, body: Body): { ref: string; refusal?: string } {
  if (kind !== "until" || isFilled(ref)) return { ref: ref?.trim() ?? "" };
  const shell = untilShell(s, untilShellAskedIn(body));
  return typeof shell === "string" ? { ref: "", refusal: shell } : { ref: shell.id };
}

async function declareAwait(req: Request, s: Session): Promise<Response> {
  const body = await jsonBody(req);
  const kind = textOf(body, "kind") ?? "";
  const ref = textOf(body, "ref");
  const unsaid = sayWhyInThreadsHeWaitsIn(s, kind, textOf(body, "why")?.trim());
  if (unsaid !== null) return new Response(unsaid, { status: 409 });
  const target = waitTargetStartingAnUntilShellFirst(s, kind, ref, body);
  if (target.refusal !== undefined) return new Response(target.refusal, { status: 409 });
  const err = declareWait(s, kind, target.ref, textOf(body, "desc")?.trim());
  return err === null || err === "" ? Response.json(describe(s)) : new Response(err, { status: 409 });
}

function readScreen(req: Request, s: Session, url: URL): Response {
  touchFrom(req, s, "read");
  const history = Number(url.searchParams.get("history") ?? 0);
  return Response.json({ ...describe(s), screen: screen(s, history) });
}

function waitReason(s: Session, text: string, re: RegExp | null, isIdle: () => boolean): string | null {
  if (s.exitCode !== null) return "exited";
  if (re) return re.test(text) ? "match" : null;
  return isIdle() ? "idle" : null;
}

async function waitForIdleOrMatch(req: Request, s: Session, url: URL): Promise<Response> {
  const idle = Number(url.searchParams.get("idle") ?? 1500);
  const timeout = Number(url.searchParams.get("timeout") ?? 120_000);
  const match = url.searchParams.get("match");
  const re = match === null || match === "" ? null : new RegExp(match, "m");
  const start = Date.now();
  touchFrom(req, s, "read", true);
  for (;;) {
    const text = screen(s, 0);
    const reason = waitReason(s, text, re, () => Date.now() - Math.max(s.lastOutputAt, start) >= idle);
    if (reason !== null || Date.now() - start >= timeout) {
      touchFrom(req, s, "read");
      return Response.json({ ...describe(s), reason: reason ?? "timeout", screen: text });
    }
    await Bun.sleep(200);
  }
}

async function handOver(req: Request, s: Session): Promise<Response> {
  const body = await jsonBody(req);
  const note = textOf(body, "note")?.trim() ?? "";
  if (note !== "") {
    const refusal = noteHandoff(s, note);
    return refusal === null ? Response.json({ noted: true }) : new Response(refusal, { status: 409 });
  }
  if (flagOf(body, "complete") === true) {
    const fresh = completeHandoff(s);
    return fresh ? Response.json(describe(fresh)) : new Response(`${s.id} has no hand-off note to act on, or is mid-turn`, { status: 409 });
  }
  const [tokens, window] = [body["tokens"], body["window"]];
  if (typeof tokens !== "number" || typeof window !== "number" || window <= 0) return new Response("note, complete, or tokens and window required", { status: 400 });
  const refusal = askForHandoffNote(s, tokens, window);
  return refusal === null ? Response.json({ asked: true }, { status: 202 }) : new Response(refusal, { status: 409 });
}

const ACTS = new Map<string, SessionAct>([
  ["handoff POST", handOver],
  ["intro GET", (_req, s) => new Response(intro(s, SENTRY_USES))],
  ["input POST", typeInto],
  ["wake POST", hisWordsTypedIntoAnAsleepPane],
  ["peer POST", nativeSendMessageQueuedWhileAsleep],
  ["notify POST", notify],
  ["state POST", claudeState],
  ["await POST", declareAwait],
  ["screen GET", readScreen],
  ["wait GET", waitForIdleOrMatch],
]);

async function actOnSession(req: Request, url: URL, match: RegExpExecArray): Promise<Response> {
  const [, id = "", verb = ""] = match;
  const s = sessions.get(id);
  if (!s) return new Response("no such session", { status: 404 });
  const act = ACTS.get(`${verb} ${req.method}`);
  return act ? act(req, s, url) : new Response("method not allowed", { status: 405 });
}

function kill(s: Session): Response {
  publish(`session/${s.id}/killed`, { session: s.id, name: s.name });
  sessions.delete(s.id);
  inboxesTable.delete(s.id);
  tmux("kill-session", "-t", tmuxName(s.id));
  s.proc?.kill();
  for (const ws of s.clients) ws.close();
  return new Response(null, { status: 204 });
}

async function renameOrArchive(req: Request, s: Session): Promise<Response> {
  const body = await jsonBody(req);
  const isArchived = flagOf(body, "archived");
  if (isArchived === true && !isFromTheBrowser(req))
    return new Response(`agents don't archive themselves: run \`${CLI} wait done\` (or wait <kind>:<ref>) and end your turn`, { status: 403 });
  if (isArchived !== undefined) setArchived(s, isArchived);
  const isUnarchivedByHandAwakeUntilItsNextTurnEnds = isArchived === false;
  if (isUnarchivedByHandAwakeUntilItsNextTurnEnds) wake(s);
  const name = textOf(body, "name")?.trim() ?? "";
  if (name !== "") {
    touchFrom(req, s, "write");
    patch(s, { name: name.slice(0, 80) });
    setOption(s.id, "@mf", JSON.stringify({ name: s.name, cmd: s.cmd, cwd: s.cwd, chatId: s.chatId, createdAt: s.createdAt }));
  }
  return Response.json(describe(s));
}

async function oneSession(req: Request, _url: URL, match: RegExpExecArray): Promise<Response> {
  const s = sessions.get(match[1] ?? "");
  if (!s) return new Response("no such session", { status: 404 });
  if (req.method === "DELETE") return kill(s);
  return req.method === "PATCH" ? renameOrArchive(req, s) : Response.json(describe(s));
}

const ROUTES: Route[] = [matching(/^\/api\/sessions\/([\w-]+)\/(input|screen|wait|notify|state|intro|await|wake|peer|handoff)$/, actOnSession), matching(/^\/api\/sessions\/([\w-]+)$/, oneSession)];

export async function sessionRoute(req: Request, url: URL, path: string): Promise<Response | undefined> {
  return firstAnswer(ROUTES, req, url, path);
}
