#!/usr/bin/env bun
// Claude Code hook: in maxflow a question to the user goes through `maxflow ask`, which opens a thread in his inbox, never the chat,
// and a SendMessage to another agent is logged, or queued by maxflow when the agent is asleep. PreToolUse(AskUserQuestion) denies the tool; Stop sends back a turn that ends on a question, once.
import { readFileSync } from "node:fs";

if (!process.env.MAXFLOW_SESSION) process.exit(0);
const input = JSON.parse(await Bun.stdin.text());
const cli = process.env.MAXFLOW_CLI ?? new URL("../cli.ts", import.meta.url).pathname;
const how = `ask only for a decision truly his, and decide the rest yourself. Run \`${cli} ask '<question>' [--default '<rec>']\`, which opens a thread in his inbox flagged as waiting on him and prints its id. Make it stand on its own (what you found, the options, your recommendation; --default only when the step is reversible), keep working on whatever doesn't hang on the answer, then \`${cli} wait thread:<id>\`; his reply is typed into your prompt as a [maxflow] message`;

if (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion") {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `In maxflow nobody watches this dialog. Ask him in a thread instead: ${how}.`,
    },
  }));
  process.exit(0);
}

// One chokepoint: agents reach each other through maxflow's event log, so the user sees every message.
// A native SendMessage to another maxflow agent is logged in the event log; an asleep one has no claude to take it, so
// maxflow queues it and wakes the agent, and the native send is stopped.
if (input.hook_event_name === "PreToolUse" && input.tool_name === "SendMessage") {
  const to = String(input.tool_input?.to ?? "");
  // A reply goes to the sender's socket (uds:/…/<pid>.sock); its pid names the session.
  const pid = Number(to.match(/^uds:.*\/(\d+)\.sock$/)?.[1]);
  const name = pid ? JSON.parse(Bun.spawnSync(["claude", "agents", "--json"]).stdout.toString() || "[]").find((a: { pid: number }) => a.pid === pid)?.name ?? "" : to;
  const target = String(name).match(/^mf-([\w-]+)/)?.[1];
  const text = String(input.tool_input?.message ?? "");
  if (target && text) {
    const res = await fetch(`http://localhost:${process.env.MAXFLOW_PORT ?? 4949}/api/sessions/${target}/peer`, { method: "POST", headers: { "x-maxflow-from": process.env.MAXFLOW_SESSION! }, body: JSON.stringify({ text }) }).catch(() => null);
    const { queued } = res?.ok ? await res.json() : { queued: false };
    if (queued)
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Delivered another way: mf-${target} was asleep, so maxflow queued your message and is waking it. Don't resend. Its reply reaches you as a message.`,
        },
      }));
  }
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
