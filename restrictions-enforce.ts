import { resolve, type Person, type Restriction } from "./restrictions";
import { isRecord, stringOr } from "./shared/guards";
import { readStateJson, writeStateJson } from "./state";

type Pending = { id: string; session: string; key: string; call: string; restriction: string; label: string; thread: string; at: number; granted?: number; used?: number; refused?: number };
const PENDING_FILE = "restrictions-pending.json";
const PASS_MS = 24 * 3_600_000;
const KEEP_PENDING_MS = 7 * 24 * 3_600_000;

const isPending = (value: unknown): value is Pending =>
  isRecord(value) && typeof value["session"] === "string" && typeof value["key"] === "string" && typeof value["thread"] === "string" && typeof value["at"] === "number";
const isPendingList = (value: unknown): value is Pending[] => Array.isArray(value) && value.every((p) => isPending(p));

const pending: Pending[] = readStateJson(PENDING_FILE, isPendingList) ?? [];
const savePending = () => {
  writeStateJson(
    PENDING_FILE,
    pending.filter((p) => Date.now() - p.at < KEEP_PENDING_MS),
  );
};

export type Call = { session: string; tool: string; input?: Record<string, unknown>; cwd?: string; objective?: string; people?: Person[] };
export type Verdict = { decision: "allow" | "deny"; reason?: string };
type OpenThreadWaitingOnHim = (session: string, text: string) => string | null;
type LogOnTheAgentsActivity = (session: string, target: string, text: string, shouldAlsoTypeIntoItsPrompt?: boolean) => void;
type Deps = { restrictions: () => Restriction[]; ask: OpenThreadWaitingOnHim; log: LogOnTheAgentsActivity; cli: string };

type Held = { c: Call; d: Deps; r: Restriction; person: Person | undefined; call: string; key: string; to: string };

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";
const isStamped = (at: number | undefined): at is number => at !== undefined && at !== 0;

const callAsHeReadsIt = (c: Call) => (c.tool === "Bash" ? stringOr(c.input?.["command"]) : `${c.tool} ${JSON.stringify(c.input ?? {})}`);

function whoOf(p: Person) {
  const github = isSet(p.github) ? `@${p.github}` : undefined;
  const slack = isSet(p.name) ? undefined : p.slack;
  const words = [p.name, p.email, github, slack].filter((word) => isSet(word));
  return words.length > 0 ? words.join(" ") : "someone";
}

const shown = (call: string) => (call.length > 600 ? `${call.slice(0, 600)}…` : call);
const allowed: Verdict = { decision: "allow" };

function block({ c, d, r, call, to }: Held): Verdict {
  d.log(c.session, `restriction: ${r.label}`, `Blocked ${c.tool}${to}: restriction "${r.label}" (${r.id}) is set to block.\n\`\`\`\n${shown(call)}\n\`\`\``);
  const note = isSet(r.note) ? `: ${r.note.replace(/\.$/, "")}` : "";
  return {
    decision: "deny",
    reason: `Blocked by yarn restriction "${r.label}" (${r.id}), which Isaac set to block${note}. Don't retry it or work around it with another tool; if the task needs it, ask him with \`${d.cli} ask\`.`,
  };
}

function useOneTimePass({ c, d, r }: Held, pass: Pending): Verdict {
  pending[pending.indexOf(pass)] = { ...pass, used: Date.now() };
  savePending();
  d.log(c.session, `restriction: ${r.label}`, `Ran ${c.tool} on Isaac's one-time approval in ${pass.thread} (restriction "${r.label}").`);
  return allowed;
}

function askHim(h: Held): Verdict {
  const { c, d, r, person, call, key, to } = h;
  const reaches = person ? `, which reaches ${whoOf(person)}` : "";
  const thread = d.ask(c.session, `May I run this${reaches}? It falls under the restriction "${r.label}", set to ask you first.\n\n\`\`\`\n${shown(call)}\n\`\`\`\n\nReply yes to let it run once, or no.`);
  if (thread === null || thread === "") return allowed;
  pending.push({ id: crypto.randomUUID().slice(0, 8), session: c.session, key, call, restriction: r.id, label: r.label, thread, at: Date.now() });
  savePending();
  d.log(c.session, `restriction: ${r.label}`, `Held ${c.tool}${to} for Isaac's approval in ${thread} (restriction "${r.label}" is set to ask).\n\`\`\`\n${shown(call)}\n\`\`\``);
  return {
    decision: "deny",
    reason: `Held by yarn restriction "${r.label}" (${r.id}): Isaac wants to approve this first. yarn asked him in thread ${thread}, naming this exact call. Don't retry it or work around it. Run \`${d.cli} wait thread:${thread}\` and end your turn (do other work first if any doesn't hang on it); when he says yes you get a one-time pass and the same call goes through.`,
  };
}

const isUnusedPass = (p: Pending) => isStamped(p.granted) && !isStamped(p.used) && Date.now() - p.granted < PASS_MS;
const isOpen = (p: Pending) => !isStamped(p.granted) && !isStamped(p.refused);
const isRecentlyRefused = (p: Pending) => isStamped(p.refused) && Date.now() - p.refused < PASS_MS;

function passOrAsk(h: Held): Verdict {
  const { c, d, r, key } = h;
  const mine = pending.filter((p) => p.session === c.session && p.key === key);
  const pass = mine.find((p) => isUnusedPass(p));
  if (pass) return useOneTimePass(h, pass);
  const open = mine.find((p) => isOpen(p));
  if (open)
    return { decision: "deny", reason: `Still waiting on Isaac: restriction "${r.label}" needs his approval, already asked in thread ${open.thread}. Run \`${d.cli} wait thread:${open.thread}\` and end your turn; on his yes, retry exactly this call.` };
  const refused = mine.findLast((p) => isRecentlyRefused(p));
  if (refused)
    return { decision: "deny", reason: `Isaac said no to this call in thread ${refused.thread} (restriction "${r.label}"). Don't run it or work around it; if something changed, ask him again there with \`${d.cli} ask --re ${refused.thread} '<why>'\`.` };
  return askHim(h);
}

export function enforce(c: Call, d: Deps): Verdict {
  const { mode, restriction: r, person } = resolve(d.restrictions(), c);
  if (mode === "allow" || !r) return allowed;
  const call = callAsHeReadsIt(c);
  const held: Held = { c, d, r, person, call, key: `${c.tool}\n${call}`, to: person ? ` to ${whoOf(person)}` : "" };
  return mode === "deny" ? block(held) : passOrAsk(held);
}

const YES = /^\s*(y|yes|yep|yeah|yup|ok|okay|sure|approved?|allow(ed)?|go( ahead)?|do it|ship it|lgtm|fine|granted)\b/i;
const NO = /^\s*(n|no|nope|don'?t|deny|denied|block|stop|cancel|never)\b/i;

function answerIn(text: string) {
  if (YES.test(text)) return "yes";
  return NO.test(text) ? "no" : undefined;
}

export function onReply(thread: string, text: string, d: Deps) {
  const p = pending.findLast((x) => x.thread === thread && isOpen(x));
  if (!p) return;
  const answer = answerIn(text);
  if (answer === undefined) return;
  if (answer === "yes") p.granted = Date.now();
  else p.refused = Date.now();
  savePending();
  d.log(
    p.session,
    `restriction: ${p.label}`,
    answer === "yes"
      ? `[maxflow] Isaac approved the call held by restriction "${p.label}" in ${thread}. You have a one-time pass: retry exactly the same call now and it goes through, once.\n\`\`\`\n${shown(p.call)}\n\`\`\``
      : `[maxflow] Isaac said no to the call held by restriction "${p.label}" in ${thread}. Don't run it or work around it.`,
    true,
  );
}
