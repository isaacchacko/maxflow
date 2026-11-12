#!/usr/bin/env bun
// questions sentry: the gate in front of the user's question queue. Each new question an agent raises is checked against
// the user's own rule for which decisions are his; one he'd want the agent to make itself goes back to it, the rest reach his queue.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const INTERVAL_MS = Number(process.env.QUESTIONS_INTERVAL ?? 3000);
const MODEL = process.env.QUESTIONS_MODEL ?? "sonnet";
const GATE = process.env.QUESTIONS_GATE !== "0";
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };

type Question = { id: number; session: string; name: string; status: string; thread: { from: string; text: string }[] };

// The user keeps the rule in his global CLAUDE.md, so the gate reads it fresh rather than holding a copy that drifts.
function rule() {
  try {
    return readFileSync(join(process.env.HOME!, ".claude/CLAUDE.md"), "utf8").match(/## Decisions that are Isaac's\n([\s\S]*?)(?=\n## |$)/)?.[1].trim() ?? "";
  } catch {
    return "";
  }
}

const system = () => `You gate the questions coding agents raise to the user, whose attention is the scarcest thing in the system. Here is his own rule for which decisions are his and which an agent should make itself:

<rule>
${rule()}
</rule>

Given one agent's question and the end of its screen, decide whether it truly needs the user. Pass it when the decision is his by that rule, when the agent lacks access or facts only he has, or when it is about to do something risky or outward-facing he hasn't asked for. Send it back when the agent could look the answer up itself, when a conventional default or the agent's own recommendation is clearly fine, when it only asks permission to keep doing the task it was given, or when it asks him to confirm or approve work it can verify itself. When unsure, pass it. Reply with exactly one line: PASS, or BOUNCE: <one or two sentences to the agent saying why it should decide this itself and, if obvious, what to do>.`;

async function screenOf(id: string) {
  const res = await fetch(`${base}/api/sessions/${id}/screen?history=150`, { headers: caller });
  return res.ok ? ((await res.json()).screen as string).slice(-6000) : "";
}

async function verdict(q: Question) {
  const input = `Agent: ${q.name} (session ${q.session})\n\nQuestion:\n${q.thread.map((m) => m.text).join("\n\n")}\n\nEnd of its screen:\n${await screenOf(q.session)}`;
  const proc = Bun.spawn(
    ["claude", "-p", "--model", MODEL, "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", system()],
    { cwd: STATE_DIR, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new Error(`claude exited ${proc.exitCode}: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  const bounce = out.match(/^BOUNCE:\s*([\s\S]+)/m);
  return bounce ? { action: "bounce", text: bounce[1].trim() } : { action: "pass" };
}

async function settle(q: Question, body: { action: string; text?: string }) {
  await fetch(`${base}/api/questions/${q.id}`, { method: "POST", headers: caller, body: JSON.stringify(body) });
  console.log(`${new Date().toLocaleTimeString()}  q${q.id}  ${q.name}  ${body.action.toUpperCase()}${body.text ? `  ${body.text}` : ""}`);
}

console.log(`questions sentry: gating new questions via ${GATE ? MODEL : "nothing (QUESTIONS_GATE=0), passing every one"}`);
for (;;) {
  try {
    const gating = ((await (await fetch(`${base}/api/questions`)).json()) as Question[]).filter((q) => q.status === "gating");
    for (const q of gating) {
      // A gate that fails lets the question through; a lost question costs more than one he didn't need.
      const body = GATE ? await verdict(q).catch((e) => (console.error(`q${q.id} gate failed:`, e), { action: "pass" })) : { action: "pass" };
      await settle(q, body);
    }
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
}
