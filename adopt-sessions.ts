import { inboxesTable, readStateText } from "./state";
import { tmux } from "./tmux";
import { attachViewer, push } from "./lifecycle";
import { type ClaudeState, type Role, type Session, type Wait, sessions } from "./sessions";
import { patch } from "./patch";
import { isRecord } from "./shared/guards";

const ADOPTED_OPTIONS = ["history_size", "@mf", "@mf-claude", "@mf-transcript", "@mf-archived", "@mf-asleep", "@mf-sentry", "@mf-wait", "@mf-role"] as const;
type PaneOptions = Partial<Record<(typeof ADOPTED_OPTIONS)[number], string>>;
type PaneMeta = Pick<Session, "name" | "cmd" | "cwd" | "createdAt"> & { chatId?: string };
const OPTION_SEPARATOR = "\u{1F}";
const CLAUDE_STATES = new Set<string>(["working", "waiting", "idle"] satisfies ClaudeState[]);

function parsedOption(text: string | undefined): unknown {
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isPaneMeta = (value: unknown): value is PaneMeta =>
  isRecord(value) &&
  typeof value["name"] === "string" &&
  Array.isArray(value["cmd"]) &&
  value["cmd"].every((arg) => typeof arg === "string") &&
  typeof value["cwd"] === "string" &&
  typeof value["createdAt"] === "number" &&
  (value["chatId"] === undefined || typeof value["chatId"] === "string");
const isClaudeHookState = (value: unknown): value is NonNullable<Session["claude"]> =>
  isRecord(value) && typeof value["state"] === "string" && CLAUDE_STATES.has(value["state"]) && typeof value["at"] === "number";
const isWait = (value: unknown): value is Wait => isRecord(value) && typeof value["kind"] === "string" && typeof value["ref"] === "string" && typeof value["at"] === "number";
const isRole = (value: unknown): value is Role => isRecord(value) && typeof value["role"] === "string" && typeof value["objective"] === "string";

function narrowed<T>(text: string | undefined, isValid: (value: unknown) => value is T): T | undefined {
  const value = parsedOption(text);
  return isValid(value) ? value : undefined;
}

function loadInbox(id: string): Pick<Session, "inbox" | "sending"> {
  const { inbox, sending } = inboxesTable.get(id) ?? { inbox: [] };
  return { inbox, ...(sending && { sending: { ...sending, text: inbox.slice(0, sending.count).join("\n") } }) };
}

function readPaneOptions(tmuxSession: string): PaneOptions {
  const formats = ADOPTED_OPTIONS.map((k) => `#{${k}}`).join(OPTION_SEPARATOR);
  const values = tmux("display-message", "-p", "-t", tmuxSession, formats).out.replace(/\n$/, "").split(OPTION_SEPARATOR);
  return Object.fromEntries(ADOPTED_OPTIONS.map((k, i) => [k, values[i]]));
}

const trimmedOrUndefined = (text: string | undefined) => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

function seedScrollbackFromTmuxHistory(session: Session, tmuxSession: string, historySize: string | undefined) {
  const history = Number(historySize) > 0 ? tmux("capture-pane", "-p", "-e", "-J", "-t", tmuxSession, "-S", "-", "-E", "-1").out : "";
  if (history.trim() !== "") push(session, new TextEncoder().encode(history.replaceAll("\n", "\r\n")));
}

function adoptSession(tmuxSession: string) {
  const id = tmuxSession.slice(3);
  const options = readPaneOptions(tmuxSession);
  const meta = narrowed(options["@mf"], isPaneMeta) ?? { name: tmuxSession, cmd: [], cwd: "", createdAt: Date.now() };
  const session: Session = { id, ...meta, lastOutputAt: meta.createdAt, chunks: [], bytes: 0, clients: new Set(), exitCode: null, ...loadInbox(id) };
  seedScrollbackFromTmuxHistory(session, tmuxSession, options.history_size);
  patch(session, {
    lastOutputAt: session.createdAt,
    claude: narrowed(options["@mf-claude"], isClaudeHookState),
    transcript: trimmedOrUndefined(options["@mf-transcript"]),
    archived: options["@mf-archived"]?.trim() === "1",
    asleep: trimmedOrUndefined(options["@mf-asleep"]),
    sentry: options["@mf-sentry"]?.trim() === "1",
    wait: narrowed(options["@mf-wait"], isWait),
    role: narrowed(options["@mf-role"], isRole),
  });
  sessions.set(id, session);
  attachViewer(session);
}

export function adoptSessionsThatOutlivedTheLastServer() {
  for (const tmuxSession of tmux("list-sessions", "-F", "#{session_name}").out.split("\n")) if (tmuxSession.startsWith("mf-")) adoptSession(tmuxSession);
  if (sessions.size > 0) console.log(`adopted ${String(sessions.size)} tmux session(s)`);
}

export function loadSavedDrafts() {
  for (const s of sessions.values()) {
    const draft = readStateText(`drafts/${s.id}.txt`);
    if (draft !== undefined) patch(s, { savedDraft: draft });
  }
}
