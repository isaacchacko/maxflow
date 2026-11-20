import { publish } from "./bus";
import { sessions } from "./sessions";
import type { Thread } from "./model";
import { isLive, saveThreads, threads } from "./stores";
import { DEFAULT_AFTER_H, DEFAULT_AFTER_MS } from "./intro";
import { dispatch } from "./lifecycle";
import { answered, message } from "./threads";
import { isFilled } from "./shared/guards";

const ASK_DEFAULTS_CHECK_MS = 60_000;

const isUnansweredDefaultDue = (t: Thread) => {
  const a = t.asks;
  return a !== undefined && isFilled(a.default) && a.shown !== undefined && a.shown !== 0 && t.paused === undefined && Date.now() - a.shown >= DEFAULT_AFTER_MS;
};

function goAheadWithDefault(t: Thread, session: string, dflt: string) {
  t.messages.push(message(session, `No answer in ${String(DEFAULT_AFTER_H)}h, so I went ahead with: ${dflt}`));
  answered(t);
  saveThreads();
  publish(`thread/${t.id}`, { thread: t.id, from: session });
  const s = sessions.get(session);
  if (isLive(s))
    dispatch({ to: [s], target: t.id, text: `[yarn] Thread ${t.id} went ${String(DEFAULT_AFTER_H)}h without his answer, so go ahead with your recommendation, which you marked reversible: "${dflt}". The thread now says you did, so he can overrule it there.` });
}

export function keepGoingAheadOnUnansweredDefaults() {
  setInterval(() => {
    for (const t of threads) {
      const a = t.asks;
      if (a !== undefined && isFilled(a.default) && isUnansweredDefaultDue(t)) goAheadWithDefault(t, a.session, a.default);
    }
  }, ASK_DEFAULTS_CHECK_MS);
}
