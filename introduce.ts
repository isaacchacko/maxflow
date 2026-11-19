import { CLI } from "./instance";
import { type Session, isAgent, isSentry } from "./sessions";
import { dispatch } from "./lifecycle";
import { SENTRY_USES } from "./sentry-uses";
import { isFilled } from "./shared/guards";

function noteAboutTheOtherEnd(other: Session, reason: string) {
  const who = `"${other.name}" (session ${other.id}, in ${other.cwd})`;
  if (isSentry(other))
    return `[maxflow] The user linked you to the ${other.name.slice(7)} sentry; it might be useful to you.${reason} ${SENTRY_USES[other.name] ?? `Its source is in ${new URL("sentries/", import.meta.url).pathname}.`}`;
  if (isAgent(other))
    return `[maxflow] The user linked you with another agent, ${who}, and wants you two talking; it got this same note about you.${reason} Start now: message it what you're working on and what you could use from it or offer it, then answer what it sends you. Keep it going while it helps; drop it once it doesn't. Message it with \`${CLI} notify ${other.id} '<text>'\`, which goes through maxflow's event log and resumes it if it is asleep. Read its screen with \`${CLI} screen ${other.id} --history 200\`.`;
  return `[maxflow] The user linked you with the terminal session ${who}, running \`${other.cmd.join(" ")}\`; it may matter to your work.${reason} Read it with \`${CLI} screen ${other.id} --history 200\`, type into it with \`${CLI} send ${other.id} '<text>'\`.`;
}

export function introduce(to: Session, other: Session, why?: string) {
  if (!isAgent(to) || to.exitCode !== null) return;
  const reason = isFilled(why) ? ` Why, in the user's words: "${why}".` : "";
  dispatch({ to: [to], target: other.name, text: noteAboutTheOtherEnd(other, reason) });
}
