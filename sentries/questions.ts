#!/usr/bin/env bun
// questions sentry: the gate in front of the user's question queue. Each new question an agent raises is checked against
// the user's own rule for which decisions are his and against the decisions he already made in the queue; one he'd want the agent
// to make itself goes back to it, one he already answered is answered from his decision, the rest reach his queue.
// It also distills each answer he gives into a standing rule, which every new agent's intro lists.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = join(process.env.HOME!, ".maxflow");
const INTERVAL_MS = Number(process.env.QUESTIONS_INTERVAL ?? 3000);
const MODEL = process.env.QUESTIONS_MODEL ?? "sonnet";
const GATE = process.env.QUESTIONS_GATE !== "0";
const base = `http://localhost:${process.env.MAXFLOW_PORT ?? 4747}`;
const caller = { "x-maxflow-from": process.env.MAXFLOW_SESSION ?? "" };

type Question = { id: number; session: string; name: string; status: string; thread: { from: string; text: string }[] };
type Decision = { q: number; name: string; question: string; answer: string; rule?: string | null };

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
// His standing rules, then his latest raw answers, since a one-off answer can still settle the same question asked again.
function decided(ds: Decision[]) {
  const rules = ds.flatMap((d) => (d.rule ? [`- ${d.rule}`] : []));
  const recent = ds.slice(-30).map((d) => `- q${d.q} (${d.name}) asked: ${clip(d.question, 400)}\n  he answered: ${clip(d.answer, 400)}`);
  return `Standing rules:\n${rules.join("\n") || "(none)"}\n\nHis latest answers:\n${recent.join("\n") || "(none)"}`;
}

// The user keeps the rule in his global CLAUDE.md, so the gate reads it fresh rather than holding a copy that drifts.
function rule() {
  try {
    return readFileSync(join(process.env.HOME!, ".claude/CLAUDE.md"), "utf8").match(/## Decisions that are Isaac's\n([\s\S]*?)(?=\n## |$)/)?.[1].trim() ?? "";
  } catch {
    return "";
  }
}

const system = (ds: Decision[]) => `You gate the questions coding agents raise to the user, whose attention is the scarcest thing in the system. Here is his own rule for which decisions are his and which an agent should make itself:

<rule>
${rule()}
</rule>

And here is what he already decided in his question queue:

<decisions>
${decided(ds)}
</decisions>

Given one agent's question and the end of its screen, decide whether it truly needs the user. Pass it when the decision is his by that rule, when the agent lacks access or facts only he has, or when it is about to do something risky or outward-facing he hasn't asked for. Send it back when the agent could look the answer up itself, when a conventional default or the agent's own recommendation is clearly fine, when it only asks permission to keep doing the task it was given, or when it asks him to confirm or approve work it can verify itself. Answer it yourself when one of his decisions above already settles it, even if he gave it to another agent. When unsure, pass it. Reply with exactly one line: PASS, or ANSWER: <his decision that settles it, quoted or closely paraphrased, and what the agent should do>, or BOUNCE: <one or two sentences to the agent saying why it should decide this itself and, if obvious, what to do>.`;

async function screenOf(id: string) {
  const res = await fetch(`${base}/api/sessions/${id}/screen?history=150`, { headers: caller });
  return res.ok ? ((await res.json()).screen as string).slice(-6000) : "";
}

async function claude(system: string, input: string) {
  const proc = Bun.spawn(
    ["claude", "-p", "--model", MODEL, "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", system],
    { cwd: STATE_DIR, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new Error(`claude exited ${proc.exitCode}: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  return out;
}

async function verdict(q: Question, ds: Decision[]) {
  const input = `Agent: ${q.name} (session ${q.session})\n\nQuestion:\n${q.thread.map((m) => m.text).join("\n\n")}\n\nEnd of its screen:\n${await screenOf(q.session)}`;
  const out = await claude(system(ds), input);
  const answer = out.match(/^ANSWER:\s*([\s\S]+)/m);
  if (answer) return { action: "standing", text: answer[1].trim() };
  const bounce = out.match(/^BOUNCE:\s*([\s\S]+)/m);
  return bounce ? { action: "bounce", text: bounce[1].trim() } : { action: "pass" };
}

const DISTILL = `The user answered a coding agent's question. Decide whether his answer is a standing decision that other agents should follow in the future, or a one-off that only settles this case. If it is standing, write it as one imperative sentence an agent can act on with no other context: no session ids, no PR numbers unless the rule is about that PR. Reply with exactly one line: RULE: <sentence>, or NONE.`;

async function distill(d: Decision) {
  const out = await claude(DISTILL, `Question:\n${d.question}\n\nHis answer:\n${d.answer}`);
  const rule = out.match(/^RULE:\s*(.+)/m)?.[1].trim() ?? null;
  await fetch(`${base}/api/decisions/${d.q}`, { method: "PATCH", headers: caller, body: JSON.stringify({ rule }) });
  console.log(`${new Date().toLocaleTimeString()}  q${d.q}  ${rule ? `RULE  ${rule}` : "one-off"}`);
}

async function settle(q: Question, body: { action: string; text?: string }) {
  await fetch(`${base}/api/questions/${q.id}`, { method: "POST", headers: caller, body: JSON.stringify(body) });
  console.log(`${new Date().toLocaleTimeString()}  q${q.id}  ${q.name}  ${body.action.toUpperCase()}${body.text ? `  ${body.text}` : ""}`);
}

// Answers that failed to distill, not retried until the sentry restarts.
const undistilled = new Set<number>();
console.log(`questions sentry: gating new questions via ${GATE ? MODEL : "nothing (QUESTIONS_GATE=0), passing every one"}`);
for (;;) {
  try {
    const ds = (await (await fetch(`${base}/api/decisions`)).json()) as Decision[];
    for (const d of ds.filter((d) => d.rule === undefined && !undistilled.has(d.q)))
      await distill(d).catch((e) => (undistilled.add(d.q), console.error(`q${d.q} distill failed:`, e)));
    const gating = ((await (await fetch(`${base}/api/questions`)).json()) as Question[]).filter((q) => q.status === "gating");
    for (const q of gating) {
      // A gate that fails lets the question through; a lost question costs more than one he didn't need.
      const body = GATE ? await verdict(q, ds).catch((e) => (console.error(`q${q.id} gate failed:`, e), { action: "pass" })) : { action: "pass" };
      await settle(q, body);
    }
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  tick failed:`, e);
  }
  await Bun.sleep(INTERVAL_MS);
}
