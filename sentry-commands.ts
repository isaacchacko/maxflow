import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DIR, LIVE, STATE_DIR } from "./instance";
import { paneEnv, respawn } from "./tmux";
import { type Session, chatOf } from "./sessions";

// Sentries are ordinary sessions, started once and kept by tmux across server restarts.
export const SENTRIES: Record<string, string[]> = Object.fromEntries(
  ["gh", "slack", "rename", ...(LIVE ? ["health"] : []), "graph", "ram", "inbox", "approval", "docs", "jev"].map((n) => [`sentry:${n}`, [process.execPath, new URL(`./sentries/${n}.ts`, import.meta.url).pathname]]),
);
// A deploy restarts a sentry whose code changed in its own pane, so it keeps its session. A claude sentry resumes its chat, unless
// its brief changed: then it starts a fresh chat, handed the last things its old one said.
export function restartSentry(s: Session, fresh: boolean) {
  let cmd = SENTRIES[s.name];
  // claude writes a chat's transcript at its first turn, and resuming one that never had a turn exits at once.
  const chat = s.transcript && existsSync(s.transcript) ? chatOf(s) : undefined;
  const claude = cmd[0] === "sh" && cmd[2].includes("exec claude ");
  if (claude && chat && !fresh) cmd = ["sh", "-c", cmd[2].replace("exec claude ", `exec claude --resume ${chat} `)];
  if (claude && chat && fresh && s.transcript) {
    const said = readFileSync(s.transcript, "utf8").split("\n").flatMap((line) => {
      try {
        const m = JSON.parse(line);
        return m.type === "assistant" ? m.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text.trim().slice(0, 300)) : [];
      } catch {
        return [];
      }
    });
    const digest = `${STATE_DIR}/${s.name.slice(7)}-restart-digest.txt`;
    writeFileSync(digest, `[maxflow] Your brief (sentries/${s.name.slice(7)}.md) changed, so a deploy restarted you in a fresh chat. Your previous chat was ${chat} (transcript ${s.transcript}, if you need more of it). The last things you said there:\n${said.slice(-6).map((t) => `- ${t}`).join("\n")}`);
    cmd = ["sh", "-c", `${cmd[2]} "$(cat '${digest}')"`];
  }
  return { ok: respawn(s.id, "-c", DIR, ...paneEnv(s.id), "--", ...cmd), resumed: claude && chat && !fresh ? chat : undefined, fresh: claude && (fresh || !chat) };
}
