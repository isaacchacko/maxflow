#!/usr/bin/env bun
// Claude Code hook: in maxflow a question to the user goes through `maxflow ask` and the questions sentry, never the chat.
// PreToolUse(AskUserQuestion) denies the dialog; Stop sends back a turn that ends on a question, once.
import { readFileSync } from "node:fs";

if (!process.env.MAXFLOW_SESSION) process.exit(0);
const input = JSON.parse(await Bun.stdin.text());
const cli = `${process.env.HOME}/Programs/maxflow/cli.ts`;
const how = `run \`${cli} ask '<question>' [--default '<rec>']\`, making it stand on its own (what you found, the options, your recommendation; --default only when the step is reversible), keep working on whatever doesn't hang on the answer, then \`${cli} wait q:<id>\`; his answer is typed into your prompt as a [maxflow] message`;

if (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion") {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `In maxflow nobody watches this dialog. Raise it with the questions sentry instead: ${how}.`,
    },
  }));
  process.exit(0);
}

if (input.hook_event_name === "Stop" && !input.stop_hook_active) {
  const text = input.last_assistant_message ?? lastAssistantText(input.transcript_path);
  const tail = text.trim().split("\n").filter((l: string) => l.trim()).at(-1) ?? "";
  if (/\?[*_`)\s]*$/.test(tail)) {
    console.log(JSON.stringify({
      decision: "block",
      reason: `Your turn ends on a question, and the user doesn't read chats for questions. If it's one only he can answer, ${how}. If you can decide it yourself, decide and carry on. If it was rhetorical or answers his question, just end the turn again.`,
    }));
  }
}

function lastAssistantText(path?: string): string {
  if (!path) return "";
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "user" && typeof entry.message?.content === "string") return "";
      if (entry.type !== "assistant") continue;
      const texts = (entry.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text);
      if (texts.length) return texts.join("\n");
    }
  } catch {}
  return "";
}
