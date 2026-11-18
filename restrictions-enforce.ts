import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./instance";
import { resolve, type Restriction } from "./restrictions";

// Enforcing restrictions on a tool call an agent is about to make (hooks/restrictions.ts asks here). deny stops it; ask stops it
// too, opens an ask to Isaac in a thread of its own naming the exact call, and keeps it pending; his yes there grants a one-time
// pass for that session and call, so the agent's retry goes through. Each pending ask lives in restrictions-pending.json.
type Pending = { id: string; session: string; key: string; call: string; restriction: string; label: string; thread: string; at: number; granted?: number; used?: number; refused?: number };
const PENDING = join(STATE_DIR, "restrictions-pending.json");
const PASS_MS = 24 * 3_600_000;
const pending: Pending[] = existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, "utf8")) : [];
const savePending = () => writeFileSync(PENDING, JSON.stringify(pending.filter((p) => Date.now() - p.at < 7 * 24 * 3_600_000)));

export type Call = { session: string; tool: string; input?: Record<string, unknown>; cwd?: string; objective?: string };
export type Verdict = { decision: "allow" | "deny"; reason?: string };
type Deps = {
  restrictions: () => Restriction[];
  // Opens a new thread from the session, flagged as waiting on him; returns its id.
  ask: (session: string, text: string) => string | null;
  // Logs a line on the agent's activity; tell also types it into the agent's prompt.
  log: (session: string, target: string, text: string, tell?: boolean) => void;
  cli: string;
};

// The call as he reads it, and as a retry is recognized: a Bash command is its command, anything else its tool and input.
const callOf = (c: Call) => (c.tool === "Bash" ? String(c.input?.command ?? "") : `${c.tool} ${JSON.stringify(c.input ?? {})}`);
const shown = (call: string) => (call.length > 600 ? `${call.slice(0, 600)}…` : call);

export function enforce(c: Call, d: Deps): Verdict {
  const { mode, restriction: r } = resolve(d.restrictions(), c);
  if (mode === "allow" || !r) return { decision: "allow" };
  const call = callOf(c);
  const key = `${c.tool}\n${call}`;
  if (mode === "deny") {
    d.log(c.session, `restriction: ${r.label}`, `Blocked ${c.tool}: restriction "${r.label}" (${r.id}) is set to block.\n\`\`\`\n${shown(call)}\n\`\`\``);
    return { decision: "deny", reason: `Blocked by maxflow restriction "${r.label}" (${r.id}), which Isaac set to block${r.note ? `: ${r.note}` : ""}. Don't retry it or work around it with another tool; if the task needs it, ask him with \`${d.cli} ask\`.` };
  }
  const mine = pending.filter((p) => p.session === c.session && p.key === key);
  const pass = mine.find((p) => p.granted && !p.used && Date.now() - p.granted < PASS_MS);
  if (pass) {
    pass.used = Date.now();
    savePending();
    d.log(c.session, `restriction: ${r.label}`, `Ran ${c.tool} on Isaac's one-time approval in ${pass.thread} (restriction "${r.label}").`);
    return { decision: "allow" };
  }
  const open = mine.find((p) => !p.granted && !p.refused);
  const refused = mine.findLast((p) => p.refused && Date.now() - p.refused < PASS_MS);
  if (refused && !open)
    return { decision: "deny", reason: `Isaac said no to this call in thread ${refused.thread} (restriction "${r.label}"). Don't run it or work around it; if something changed, ask him again there with \`${d.cli} ask --re ${refused.thread} '<why>'\`.` };
  if (open)
    return { decision: "deny", reason: `Still waiting on Isaac: restriction "${r.label}" needs his approval, already asked in thread ${open.thread}. Run \`${d.cli} wait thread:${open.thread}\` and end your turn; on his yes, retry exactly this call.` };
  const thread = d.ask(c.session, `May I run this? It falls under the restriction "${r.label}", set to ask you first.\n\n\`\`\`\n${shown(call)}\n\`\`\`\n\nReply yes to let it run once, or no.`);
  if (!thread) return { decision: "allow" };
  pending.push({ id: crypto.randomUUID().slice(0, 8), session: c.session, key, call, restriction: r.id, label: r.label, thread, at: Date.now() });
  savePending();
  d.log(c.session, `restriction: ${r.label}`, `Held ${c.tool} for Isaac's approval in ${thread} (restriction "${r.label}" is set to ask).\n\`\`\`\n${shown(call)}\n\`\`\``);
  return { decision: "deny", reason: `Held by maxflow restriction "${r.label}" (${r.id}): Isaac wants to approve this first. maxflow asked him in thread ${thread}, naming this exact call. Don't retry it or work around it. Run \`${d.cli} wait thread:${thread}\` and end your turn (do other work first if any doesn't hang on it); when he says yes you get a one-time pass and the same call goes through.` };
}

const YES = /^\s*(y|yes|yep|yeah|yup|ok|okay|sure|approved?|allow(ed)?|go( ahead)?|do it|ship it|lgtm|fine|granted)\b/i;
const NO = /^\s*(n|no|nope|don'?t|deny|denied|block|stop|cancel|never)\b/i;

// His reply in a thread an ask opened: yes grants the pass and no refuses it, and the agent is told either way. Anything else
// leaves it pending; his words still reach the agent as any reply does.
export function onReply(thread: string, text: string, d: Deps) {
  const p = pending.findLast((x) => x.thread === thread && !x.granted && !x.refused);
  if (!p) return;
  const verdict = YES.test(text) ? "yes" : NO.test(text) ? "no" : null;
  if (!verdict) return;
  if (verdict === "yes") p.granted = Date.now();
  else p.refused = Date.now();
  savePending();
  d.log(
    p.session,
    `restriction: ${p.label}`,
    verdict === "yes"
      ? `[maxflow] Isaac approved the call held by restriction "${p.label}" in ${thread}. You have a one-time pass: retry exactly the same call now and it goes through, once.\n\`\`\`\n${shown(p.call)}\n\`\`\``
      : `[maxflow] Isaac said no to the call held by restriction "${p.label}" in ${thread}. Don't run it or work around it.`,
    true,
  );
}
