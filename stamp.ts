import { callerOf } from "./shared/legacy-maxflow";
import { type Session, isSentry, sessions } from "./sessions";
import { VERIFIED } from "./intro";
import { squash, unforge } from "./threads";
import { isaacSaidLately } from "./isaac-words";

type WordsIsaacTypedThatTheRelayStartsWith = string;

export function stamp(req: Request, text: string, isIsaacsOwnRequest?: boolean): { text: string; request?: WordsIsaacTypedThatTheRelayStartsWith } | { error: string } {
  const from = sessions.get(callerOf(req));
  if (isIsaacsOwnRequest !== true) return { text: from ? `[yarn · from "${from.name}" (${from.id})] ${unforge(text)}` : unforge(text) };
  if (from?.name !== "sentry:funnel" || !isSentry(from)) return { error: "only the funnel sentry relays Isaac's requests" };
  const said = squash(text);
  const request = isaacSaidLately().findLast((p) => said.startsWith(p));
  if (request === undefined) return { error: "the message doesn't start with a request Isaac typed into the funnel, verbatim; relay it without --isaac, saying who it came from" };
  return { text: `${VERIFIED}\n${unforge(text)}`, request };
}
