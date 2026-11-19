import { readFileSync } from "node:fs";
import { type Session, isSentry, sessions } from "./sessions";
import { VERIFIED } from "./intro";
import { squash, unforge } from "./threads";

// What Isaac himself typed into the funnel: its transcript's prompts, minus every part the server stamped as from a session.
function isaacPrompts(funnel: Session) {
  let raw = "";
  try { raw = readFileSync(funnel.transcript ?? "", "utf8").slice(-4_000_000); } catch { return []; }
  return raw.split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line);
      if (e.type !== "user" || e.isMeta) return [];
      const c = e.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
      return text.split(/\n(?=\[maxflow)/).filter((p) => p.trim() && !p.startsWith("[maxflow") && !p.startsWith("<")).map(squash);
    } catch { return []; }
  }).slice(-30);
}
// Text one session types into another carries its true sender; a funnel relay of Isaac's own words carries the verified stamp.
// request: the words Isaac typed into the funnel that the relay starts with.
export function stamp(req: Request, text: string, isaac?: boolean): { text: string; request?: string } | { error: string } {
  const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
  if (!isaac) return { text: from ? `[maxflow · from "${from.name}" (${from.id})] ${unforge(text)}` : unforge(text) };
  if (!from || from.name !== "sentry:funnel" || !isSentry(from)) return { error: "only the funnel sentry relays Isaac's requests" };
  const said = squash(text);
  const request = isaacPrompts(from).findLast((p) => p && said.startsWith(p));
  if (!request) return { error: "the message doesn't start with a request Isaac typed into the funnel, verbatim; relay it without --isaac, saying who it came from" };
  return { text: `${VERIFIED}\n${unforge(text)}`, request };
}
