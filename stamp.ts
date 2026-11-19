import { readFileSync } from "node:fs";
import { type Session, isSentry, sessions } from "./sessions";
import { VERIFIED } from "./intro";
import { squash, unforge } from "./threads";
import { isRecord } from "./shared/guards";

type WordsIsaacTypedThatTheRelayStartsWith = string;

function transcriptTail(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").slice(-4_000_000);
  } catch {
    return undefined;
  }
}

function promptTextOf(entry: unknown): string | undefined {
  if (!isRecord(entry) || entry["type"] !== "user" || Boolean(entry["isMeta"])) return undefined;
  const content = isRecord(entry["message"]) ? entry["message"]["content"] : undefined;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.flatMap((part) => (isRecord(part) && part["type"] === "text" ? [part["text"]] : [])).join("\n") : "";
}

function partsTheServerDidNotStampAsFromASession(line: string): string[] {
  try {
    const text = promptTextOf(JSON.parse(line));
    if (text === undefined) return [];
    return text.split(/\n(?=\[maxflow)/).filter((p) => p.trim() !== "" && !p.startsWith("[maxflow") && !p.startsWith("<")).map(squash);
  } catch {
    return [];
  }
}

function promptsIsaacTypedIntoTheFunnel(funnel: Session) {
  const raw = transcriptTail(funnel.transcript ?? "");
  if (raw === undefined) return [];
  return raw.split("\n").flatMap(partsTheServerDidNotStampAsFromASession).slice(-30);
}

export function stamp(req: Request, text: string, isIsaacsOwnRequest?: boolean): { text: string; request?: WordsIsaacTypedThatTheRelayStartsWith } | { error: string } {
  const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
  if (isIsaacsOwnRequest !== true) return { text: from ? `[maxflow · from "${from.name}" (${from.id})] ${unforge(text)}` : unforge(text) };
  if (from?.name !== "sentry:funnel" || !isSentry(from)) return { error: "only the funnel sentry relays Isaac's requests" };
  const said = squash(text);
  const request = promptsIsaacTypedIntoTheFunnel(from).findLast((p) => p !== "" && said.startsWith(p));
  if (request === undefined) return { error: "the message doesn't start with a request Isaac typed into the funnel, verbatim; relay it without --isaac, saying who it came from" };
  return { text: `${VERIFIED}\n${unforge(text)}`, request };
}
