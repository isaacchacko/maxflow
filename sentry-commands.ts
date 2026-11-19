import { existsSync, readFileSync } from "node:fs";
import { DIR, LIVE } from "./instance";
import { paneEnv, respawn } from "./tmux";
import { type Session, chatOf } from "./sessions";
import { writeStateText } from "./state";
import { LIVE_ONLY_SENTRIES, PLAIN_SENTRIES } from "./sentry-names";
import { isFilled, isRecord } from "./shared/guards";

export const SENTRIES: Record<string, string[]> = Object.fromEntries(
  PLAIN_SENTRIES.filter((n) => LIVE || !LIVE_ONLY_SENTRIES.has(n)).map((n) => [`sentry:${n}`, [process.execPath, new URL(`sentries/${n}.ts`, import.meta.url).pathname]]),
);

const isTextPart = (part: unknown): part is { type: "text"; text: string } => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string";

function assistantTextsOf(line: string): string[] {
  try {
    const entry: unknown = JSON.parse(line);
    if (!isRecord(entry) || entry["type"] !== "assistant") return [];
    const content = isRecord(entry["message"]) ? entry["message"]["content"] : undefined;
    if (!Array.isArray(content)) return [];
    return content.filter(isTextPart).map((part) => part.text.trim().slice(0, 300));
  } catch {
    return [];
  }
}

function freshChatHandedTheOldOnesLastWords(s: Session, script: string, chat: string, transcript: string): string[] {
  const said = readFileSync(transcript, "utf8").split("\n").flatMap(assistantTextsOf);
  const name = s.name.slice(7);
  const digest = writeStateText(`${name}-restart-digest.txt`, `[maxflow] Your brief (sentries/${name}.md) changed, so a deploy restarted you in a fresh chat. Your previous chat was ${chat} (transcript ${transcript}, if you need more of it). The last things you said there:\n${said.slice(-6).map((t) => `- ${t}`).join("\n")}`);
  return ["sh", "-c", `${script} "$(cat '${digest}')"`];
}

function restartCommand(s: Session, command: string[], chat: string | undefined, hasBriefChanged: boolean): string[] {
  const [program, , script = ""] = command;
  if (program !== "sh" || !script.includes("exec claude ") || !isFilled(chat)) return command;
  if (!hasBriefChanged) return ["sh", "-c", script.replace("exec claude ", () => `exec claude --resume ${chat} `)];
  return isFilled(s.transcript) ? freshChatHandedTheOldOnesLastWords(s, script, chat, s.transcript) : command;
}

export function restartSentry(s: Session, hasBriefChanged: boolean) {
  const command = SENTRIES[s.name] ?? [];
  // constraint: claude writes a chat's transcript at its first turn, and resuming a chat that never had a turn exits at once
  const chat = isFilled(s.transcript) && existsSync(s.transcript) ? chatOf(s) : undefined;
  const isClaude = command[0] === "sh" && (command[2] ?? "").includes("exec claude ");
  const isResuming = isClaude && isFilled(chat) && !hasBriefChanged;
  const isRespawned = respawn(s.id, "-c", DIR, ...paneEnv(s.id), "--", ...restartCommand(s, command, chat, hasBriefChanged));
  return { ok: isRespawned, resumed: isResuming ? chat : undefined, fresh: isClaude && (hasBriefChanged || !isFilled(chat)) };
}
