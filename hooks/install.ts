import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOKS = import.meta.dir;
const SETTINGS = join(homedir(), ".claude/settings.json");
const state = (s: string) => `${HOOKS}/claude-state.sh ${s}`;
const questions = `${HOOKS}/claude-questions.ts`;
const restrictions = `${HOOKS}/restrictions.ts`;
const HOOKS_INERT_OUTSIDE_A_MAXFLOW_PANE: Record<string, { matcher?: string; command: string }[]> = {
  SessionStart: [{ command: state("idle") }, { command: `${HOOKS}/claude-intro.sh` }],
  UserPromptSubmit: [{ command: state("working") }],
  PreToolUse: [{ command: state("working") }, { matcher: "AskUserQuestion|SendMessage", command: questions }, { command: restrictions }],
  PostToolUse: [{ command: state("working") }],
  PermissionRequest: [{ command: state("waiting") }],
  Notification: [{ matcher: "permission_prompt", command: state("waiting") }],
  Stop: [{ command: state("idle") }, { command: questions }],
  StopFailure: [{ command: state("idle") }],
  SessionEnd: [{ command: state("gone") }],
};

type Settings = { hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>; [key: string]: unknown };

function isSettings(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(): Settings {
  if (!existsSync(SETTINGS)) return {};
  const parsed: unknown = JSON.parse(readFileSync(SETTINGS, "utf8"));
  if (!isSettings(parsed)) throw new TypeError(`${SETTINGS} is not a JSON object`);
  return parsed;
}

export function installHooks() {
  const settings = readSettings();
  const hooks = (settings.hooks ??= {});
  const otherMaxflowsHook = Object.values(hooks).flat().flatMap((e) => e.hooks).find((h) => /claude-(intro|state)\.sh/.test(h.command) && !h.command.startsWith(HOOKS));
  if (otherMaxflowsHook) return `hooks: left as they are, another maxflow's are installed (${otherMaxflowsHook.command.split(" ", 1)[0] ?? ""})`;
  let added = 0;
  for (const [event, wanted] of Object.entries(HOOKS_INERT_OUTSIDE_A_MAXFLOW_PANE))
    for (const w of wanted) {
      const list = (hooks[event] ??= []);
      if (list.some((e) => e.hooks.some((h) => h.command === w.command) && e.matcher === w.matcher)) continue;
      list.push({ ...(w.matcher !== undefined && { matcher: w.matcher }), hooks: [{ type: "command", command: w.command }] });
      added += 1;
    }
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  return `hooks: ${added > 0 ? `added ${added} to` : "already in"} ${SETTINGS}`;
}
