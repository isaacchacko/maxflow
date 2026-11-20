import { publish } from "./bus";
import { CLI } from "./instance";
import { peekStateJson } from "./state";
import { type Session, sessions } from "./sessions";
import type { Message, Thread } from "./model";
import { isLive, saveThreads, tasks, threads } from "./stores";
import { DEFAULT_AFTER_H } from "./intro";
import { derive, dispatch, setWait } from "./lifecycle";
import { headline, message } from "./threads";
import { patch } from "./patch";
import { isFilled, isRecord } from "./shared/guards";

const STUBS_SINCE_HIS_MIDNIGHT = Date.parse("2026-11-18T08:00:00Z");
const RETIRED_COMMAND_FIELDS = ["kind", "kindBy", "done"];
const LEGACY_QUESTION_WAIT_KIND = "q";

type QuestionMessage = { from: string; text: string; at: number };
type Question = { id: number; session: string; name: string; status: string; at: number; thread: QuestionMessage[]; default?: string };

const isQuestionMessage = (value: unknown): value is QuestionMessage =>
  isRecord(value) && typeof value["from"] === "string" && typeof value["text"] === "string" && typeof value["at"] === "number";
const isQuestion = (value: unknown): value is Question =>
  isRecord(value) &&
  typeof value["id"] === "number" &&
  typeof value["session"] === "string" &&
  typeof value["name"] === "string" &&
  typeof value["status"] === "string" &&
  Array.isArray(value["thread"]) &&
  value["thread"].every(isQuestionMessage) &&
  (value["default"] === undefined || typeof value["default"] === "string");

export function markMovedStubsSinceHisMidnight() {
  for (const t of threads) {
    const lastAt = Math.max(...t.messages.map((m) => m.at));
    if (t.mergedInto !== undefined && t.moved === undefined && t.messages.some((m) => m.from === "isaac") && lastAt >= STUBS_SINCE_HIS_MIDNIGHT) patch(t, { moved: { at: lastAt } });
  }
}

export function retireCommandFields() {
  for (const t of threads) {
    for (const field of RETIRED_COMMAND_FIELDS) Reflect.deleteProperty(t, field);
    for (const m of t.messages) Reflect.deleteProperty(m, "re");
  }
}

const storedId = (m: Message): unknown => Reflect.get(m, "id");
const hasStoredId = (m: Message) => {
  const id = storedId(m);
  return typeof id === "string" && id !== "";
};

export function giveMessagesFromBeforeSubthreadsIds() {
  if (threads.every((t) => t.messages.every(hasStoredId))) return;
  for (const t of threads)
    for (const m of t.messages) {
      const id = storedId(m);
      if (id === undefined || id === null) patch(m, { id: `m-${crypto.randomUUID().slice(0, 6)}` });
    }
  saveThreads();
}

function questionThread(q: Question, s: Session | undefined): Thread {
  const said = q.thread.filter((m) => m.from !== "sentry");
  const goAheadNote = isFilled(q.default) ? [message(q.session, `If you haven't answered in ${DEFAULT_AFTER_H}h, I go ahead with: ${q.default}`)] : [];
  return {
    id: `th-${crypto.randomUUID().slice(0, 6)}`,
    title: headline(said[0]?.text ?? q.name).slice(0, 80),
    objective: s?.role?.objective ?? "",
    routers: [q.session],
    messages: [...said.map((m) => ({ ...message(m.from === "user" ? "isaac" : q.session, m.text), at: m.at })), ...goAheadNote],
    q: q.id,
    asks: { session: q.session, since: Date.now(), ...(isFilled(q.default) && { default: q.default }) },
  };
}

function moveQuestionWaitOntoThread(s: Session, q: Question, t: Thread) {
  const kind: string | undefined = s.wait?.kind;
  if (s.wait && kind === LEGACY_QUESTION_WAIT_KIND && s.wait.ref.replace(/^q/, "") === String(q.id)) setWait(s, { ...s.wait, kind: "thread", ref: t.id });
}

function tellAskerWhereTheQuestionMoved(s: Session, q: Question, t: Thread) {
  const waitAdvice = s.wait?.kind === "thread" && s.wait.ref === t.id ? `Your wait is now thread:${t.id}.` : `Wait on it with \`${CLI} wait thread:${t.id}\`.`;
  dispatch({
    to: [s],
    target: t.id,
    text: `[yarn] Questions are threads now. Your question q${String(q.id)} moved into thread ${t.id} in the user's inbox, flagged as waiting on him; his reply there is typed into your prompt and ends your wait. ${waitAdvice} Answer him with \`${CLI} thread post ${t.id} '<text>'\`, and ask him anything new with \`${CLI} ask\`, which opens a thread.`,
  });
}

function migrateQuestion(q: Question) {
  if ((q.status !== "pending" && q.status !== "gating") || threads.some((t) => t.q === q.id)) return;
  const s = sessions.get(q.session);
  const t = questionThread(q, s);
  threads.push(t);
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, from: q.session, asks: true });
  if (s) moveQuestionWaitOntoThread(s, q, t);
  if (isLive(s)) tellAskerWhereTheQuestionMoved(s, q, t);
}

export function migrateOpenQuestionsIntoThreads() {
  const questions = peekStateJson("questions.json");
  if (!Array.isArray(questions)) return;
  for (const q of questions) if (isQuestion(q)) migrateQuestion(q);
}

export function settleColumnsOfTasksFromBeforeSettling() {
  for (const t of tasks) if (!("derived" in t)) patch(t, { derived: derive(t)?.to });
}
