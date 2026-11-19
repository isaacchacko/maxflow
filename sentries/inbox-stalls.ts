import { onBoard, repoAndNumber, shortened } from "./inbox-board";
import { type Question, state } from "./inbox-state";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const QUESTION_STALL_MS = 3 * HOUR_MS;
const QUESTION_FORGOTTEN_MS = 7 * DAY_MS;
const REVIEW_STALL_MS = 24 * HOUR_MS;
const IDLE_STALL_MS = 3 * DAY_MS;

function isNewlyFlagged(tag: string) {
  if (state.flagged.includes(tag)) return false;
  state.flagged = [...state.flagged, tag].slice(-1000);
  return true;
}

async function raisePrStalls(now: number) {
  for (const [key, pr] of Object.entries(state.prs)) {
    if (pr.gone !== undefined && pr.gone !== 0) continue;
    const title = `Review ${repoAndNumber(key)}: ${shortened(pr.title, 60)}`;
    if (pr.why === "review" && now - pr.requested > REVIEW_STALL_MS && isNewlyFlagged(`${key}:wait:${pr.requested}`))
      await onBoard(key, pr.url, `${pr.author} has waited ${Math.floor((now - pr.requested) / HOUR_MS)}h on your review`, { title, status: "you" });
    if (now - pr.updated > IDLE_STALL_MS && isNewlyFlagged(`${key}:idle:${pr.updated}`))
      await onBoard(key, pr.url, `no activity for ${Math.floor((now - pr.updated) / DAY_MS)} days`, { title });
  }
}

function staleQuestionsByConversation(now: number) {
  const stale = new Map<string, [string, Question][]>();
  const settled = new Set<string>();
  for (const [ts, q] of Object.entries(state.questions)) {
    if ((state.answered[q.key] ?? 0) > Number(ts) || now - q.at > QUESTION_FORGOTTEN_MS) settled.add(ts);
    else if (now - q.at > QUESTION_STALL_MS && isNewlyFlagged(`q:${ts}`)) stale.set(q.key, [...(stale.get(q.key) ?? []), [ts, q]]);
  }
  state.questions = Object.fromEntries(Object.entries(state.questions).filter(([ts]) => !settled.has(ts)));
  return stale;
}

async function noteStaleQuestions(key: string, questions: [string, Question][], now: number) {
  const [oldest] = questions.toSorted((a, b) => Number(a[0]) - Number(b[0]));
  if (!oldest) return;
  const [ts, q] = oldest;
  const isMany = questions.length > 1;
  const asked = isMany ? `${questions.length} questions from ${q.who}` : `${q.who}'s question`;
  const hours = Math.floor((now - Number(ts) * 1000) / HOUR_MS);
  const note = `${asked} still ${isMany ? "have" : "has"} no answer from you, ${hours}h after ${isMany ? "the first was" : "it was"} sent`;
  await onBoard(key, q.link, note, { title: `Reply to ${q.who}: "${shortened(q.text, 50)}"`, status: "you" });
}

export async function raiseStalls() {
  const now = Date.now();
  await raisePrStalls(now);
  for (const [key, questions] of staleQuestionsByConversation(now)) await noteStaleQuestions(key, questions, now);
  state.stallAt = now;
}
