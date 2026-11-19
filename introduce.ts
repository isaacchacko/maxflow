import { CLI } from "./instance";
import { type Session, isAgent, isSentry } from "./sessions";
import { dispatch } from "./lifecycle";
import { SENTRY_USES } from "./world";

// An edge drawn in the graph: tell each agent end who is on the other side and how to reach it.
export function introduce(to: Session, other: Session, why?: string) {
  if (!isAgent(to) || to.exitCode !== null) return;
  const who = `"${other.name}" (session ${other.id}, in ${other.cwd})`;
  const reason = why ? ` Why, in the user's words: "${why}".` : "";
  const text = isSentry(other)
    ? `[maxflow] The user linked you to the ${other.name.slice(7)} sentry; it might be useful to you.${reason} ${SENTRY_USES[other.name] ?? `Its source is in ${new URL("./sentries/", import.meta.url).pathname}.`}`
    : isAgent(other)
      ? `[maxflow] The user linked you with another agent, ${who}, and wants you two talking; it got this same note about you.${reason} Start now: message it what you're working on and what you could use from it or offer it, then answer what it sends you. Keep it going while it helps; drop it once it doesn't. Message it with \`${CLI} notify ${other.id} '<text>'\`, which goes through maxflow's event log and resumes it if it is asleep. Read its screen with \`${CLI} screen ${other.id} --history 200\`.`
      : `[maxflow] The user linked you with the terminal session ${who}, running \`${other.cmd.join(" ")}\`; it may matter to your work.${reason} Read it with \`${CLI} screen ${other.id} --history 200\`, type into it with \`${CLI} send ${other.id} '<text>'\`.`;
  dispatch({ to: [to], target: other.name, text });
}
