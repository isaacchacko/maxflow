#!/usr/bin/env bun
import { readFileSync } from "node:fs";

type HookInput = {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
  transcript_path?: unknown;
};
type TranscriptEntry = { type?: unknown; message?: { content?: unknown } };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookInput(value: unknown): HookInput {
  return typeof value === "object" && value !== null ? value : {};
}

const session = process.env["MAXFLOW_SESSION"];
if (session === undefined || session === "") process.exit(0);
const input = hookInput(JSON.parse(await Bun.stdin.text()));
const cli = process.env["MAXFLOW_CLI"] ?? new URL("../cli.ts", import.meta.url).pathname;
const askThroughAThreadInHisInbox = `ask only for a decision truly his, and decide the rest yourself. Run \`${cli} ask '<question>' [--default '<rec>']\`, which opens a thread in his inbox flagged as waiting on him and prints its id. Make it stand on its own (what you found, the options, your recommendation; --default only when the step is reversible), keep working on whatever doesn't hang on the answer, then \`${cli} wait thread:<id>\`; his reply is typed into your prompt as a [maxflow] message`;

function denyAskUserQuestion(): never {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `In maxflow nobody watches this dialog. Ask him in a thread instead: ${askThroughAThreadInHisInbox}.`,
    },
  }));
  process.exit(0);
}

// constraint: a SendMessage reply goes to the sender's socket (uds:/…/<pid>.sock), and only `claude agents --json` maps that pid to a session name
function agentNameOf(to: string) {
  const pid = Number(/^uds:.*\/(\d+)\.sock$/.exec(to)?.[1]);
  if (Number.isNaN(pid) || pid === 0) return to;
  const agents: unknown = JSON.parse(Bun.spawnSync(["claude", "agents", "--json"]).stdout.toString() || "[]");
  if (!Array.isArray(agents)) throw new TypeError("claude agents --json did not print a list");
  const agent: unknown = agents.find((a) => isObject(a) && a["pid"] === pid);
  return String((isObject(agent) ? agent["name"] : undefined) ?? "");
}

async function postToPeer(target: string, text: string, from: string) {
  try {
    return await fetch(`http://localhost:${process.env["MAXFLOW_PORT"] ?? 4949}/api/sessions/${target}/peer`, {
      method: "POST",
      headers: { "x-maxflow-from": from },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
}

async function wasQueuedForAnAsleepAgent(res: Response | null) {
  if (res?.ok !== true) return false;
  const body: unknown = await res.json();
  return isObject(body) && Boolean(body["queued"]);
}

async function logSendMessageInMaxflowsEventLog(from: string) {
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const target = /^mf-([\w-]+)/.exec(agentNameOf(String(toolInput["to"] ?? "")))?.[1];
  const text = String(toolInput["message"] ?? "");
  if (target === undefined || text === "") return;
  if (!(await wasQueuedForAnAsleepAgent(await postToPeer(target, text, from)))) return;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Delivered another way: mf-${target} was asleep, so maxflow queued your message and is waking it. Don't resend. Its reply reaches you as a message.`,
    },
  }));
}

function assistantTextOf(entry: TranscriptEntry) {
  const content = entry.message?.content ?? [];
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter((c) => isObject(c) && c["type"] === "text").map((c: Record<string, unknown>) => String(c["text"] ?? ""));
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function lastAssistantText(path: string | undefined): string {
  if (path === undefined || path === "") return "";
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    for (const line of lines.toReversed()) {
      const entry: TranscriptEntry = hookInput(JSON.parse(line));
      if (entry.type === "user" && typeof entry.message?.content === "string") return "";
      if (entry.type !== "assistant") continue;
      if (entry.message?.content !== undefined && entry.message.content !== null && !Array.isArray(entry.message.content)) return "";
      const text = assistantTextOf(entry);
      if (text !== undefined) return text;
    }
  } catch {
    return "";
  }
  return "";
}

function sendBackATurnEndingOnAQuestion() {
  const text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : lastAssistantText(typeof input.transcript_path === "string" ? input.transcript_path : undefined);
  const tail = text.trim().split("\n").findLast((l) => l.trim() !== "") ?? "";
  if (!/\?[*_`)\s]*$/.test(tail)) return;
  console.log(JSON.stringify({
    decision: "block",
    reason: `Your turn ends on a question, and the user doesn't read chats for questions. If it's one only he can answer, ${askThroughAThreadInHisInbox}. If you can decide it yourself, decide and carry on. If it was rhetorical or answers his question, just end the turn again.`,
  }));
}

if (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion") denyAskUserQuestion();

if (input.hook_event_name === "PreToolUse" && input.tool_name === "SendMessage") {
  await logSendMessageInMaxflowsEventLog(session);
  process.exit(0);
}

const isStopHookActive = Boolean(input.stop_hook_active);
if (input.hook_event_name === "Stop" && !isStopHookActive) sendBackATurnEndingOnAQuestion();
