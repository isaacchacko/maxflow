import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The Claude Code hooks maxflow needs, added to ~/.claude/settings.json. Each one does nothing outside a maxflow pane
// ($MAXFLOW_SESSION unset), so they are safe for every claude on the machine.
const HOOKS = import.meta.dir;
const SETTINGS = join(process.env.HOME!, ".claude/settings.json");
const state = (s: string) => `${HOOKS}/claude-state.sh ${s}`;
const questions = `${process.execPath} ${HOOKS}/claude-questions.ts`;
const WANTED: Record<string, { matcher?: string; command: string }[]> = {
  SessionStart: [{ command: `${HOOKS}/claude-intro.sh` }],
  UserPromptSubmit: [{ command: state("working") }],
  PostToolUse: [{ command: state("working") }],
  Notification: [{ matcher: "permission_prompt", command: state("waiting") }],
  Stop: [{ command: state("idle") }, { command: questions }],
  SessionEnd: [{ command: state("gone") }],
  PreToolUse: [{ matcher: "AskUserQuestion|SendMessage", command: questions }],
};

type Entry = { matcher?: string; hooks: { type: string; command: string }[] };

export function installHooks() {
  const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf8")) : {};
  const hooks: Record<string, Entry[]> = (settings.hooks ??= {});
  // Another maxflow checkout's hooks speak the same API through $MAXFLOW_PORT; adding ours too would fire each one twice.
  const other = Object.values(hooks).flat().flatMap((e) => e.hooks).find((h) => /claude-(intro|state)\.sh/.test(h.command) && !h.command.startsWith(HOOKS));
  if (other) return `hooks: left as they are, another maxflow's are installed (${other.command.split(" ")[0]})`;
  let added = 0;
  for (const [event, wanted] of Object.entries(WANTED))
    for (const w of wanted) {
      const list = (hooks[event] ??= []);
      if (list.some((e) => e.hooks.some((h) => h.command === w.command) && e.matcher === w.matcher)) continue;
      list.push({ ...(w.matcher && { matcher: w.matcher }), hooks: [{ type: "command", command: w.command }] });
      added++;
    }
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  return `hooks: ${added ? `added ${added} to` : "already in"} ${SETTINGS}`;
}
