import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { STATE_DIR } from "./instance";
import { shellText } from "./restrictions-shell";

// His autonomy restrictions: what his agents may do on their own (allow), must ask him first (ask), or may never do (deny).
// The server serves and edits them (/api/restrictions), the Restrictions page shows them, and the enforcement hook
// (hooks/restrictions.ts) runs resolve() on every tool call. This module reads and writes no server state, so the hook
// and the CLI can import it alone.
export const MODES = ["allow", "ask", "deny"] as const;
export type Mode = (typeof MODES)[number];
// match.tools: regexes on the whole Claude Code tool_name; match.bash: regexes found anywhere in a Bash command.
// scope: it applies only on that objective, only under that path prefix, and only to those people; no scope applies everywhere.
// parent: an override of another restriction, for some people or some place, which uses that one's matchers instead of its own.
export type Restriction = {
  id: string;
  action: string;
  label: string;
  mode: Mode;
  match: { tools?: string[]; bash?: string[] };
  scope?: { objective?: string; cwd?: string; people?: Person[] };
  parent?: string;
  note?: string;
  builtin?: boolean;
};
// Someone a call reaches: a message's recipient, a PR's author, a mallory target. Any shared id is the same person; in a
// restriction's scope, {team: true} stands for every teammate.
export type Person = { name?: string; slack?: string; email?: string; github?: string; team?: boolean };
// people: who the call reaches, as the hook reads them from its input; none for a call that reaches no one in particular.
export type Call = { tool: string; input?: Record<string, unknown>; cwd?: string; objective?: string; people?: Person[] };

const SLACK = "mcp__claude_ai_Slack__";
const GMAIL = "mcp__claude_ai_Gmail__";
const M365 = "mcp__claude_ai_Microsoft_365__";
const builtin = (id: string, action: string, label: string, mode: Mode, match: Restriction["match"], note: string): Restriction =>
  ({ id, action, label, mode, match, note, builtin: true });

// The catalog he starts with, seeded from his standing rules so nothing that works today breaks on day one:
// approving and merging PRs is allowed, an outward-facing message to a person asks him first, and what he has
// already forbidden (requesting reviewers, killing processes by pattern) is blocked. action is the kind the page groups by.
export const SEED: Restriction[] = [
  builtin("slack", "message", "Message a person on Slack", "ask", { tools: [`${SLACK}slack_send_message`, `${SLACK}slack_schedule_message`] },
    "Outward-facing: a message he has not asked for waits on him. Drafts are not covered."),
  builtin("email", "message", "Send or reply to an email", "ask", { tools: [`${GMAIL}(send_message|reply|forward)`, `${M365}outlook_(send_mail|send_draft|forward_mail)`] },
    "Gmail and Outlook. Drafts are not covered."),
  builtin("teams", "message", "Message someone on Teams", "ask", { tools: [`${M365}teams_(send_chat_message|send_channel_message|reply_channel_message|create_chat)`] }, ""),
  builtin("mallory-phone", "message", "Mallory to his phone", "ask", { bash: ["\\bmallory\\s+send\\b.*--to\\s+(umbrella|all)\\b"] },
    "umbrella is his phone, with no agent: a person reads it. Agent-to-agent mallory is not covered."),
  builtin("calendar", "message", "Create or answer a calendar event", "ask", { tools: [`${M365}outlook_(create_event|update_event|delete_event|respond_to_event)`] },
    "Invites reach other people."),
  builtin("pr-comment", "review", "Comment on or review a PR", "allow", { bash: ["\\bgh\\s+pr\\s+comment\\b", "\\bgh\\s+pr\\s+review\\b(?!.*(--approve|\\s-a\\b))", "\\bgh\\s+api\\b.*/pulls/\\d+/(comments|reviews)"] },
    "Approving is its own restriction."),
  builtin("pr-approve", "approve", "Approve a PR", "allow", { bash: ["\\bgh\\s+pr\\s+review\\b.*(--approve|\\s-a\\b)"] },
    "An agent that read the diff and found it good approves it, as him."),
  builtin("pr-merge", "merge", "Merge a PR or arm auto-merge", "allow", { bash: ["\\bgh\\s+pr\\s+merge\\b", "\\bgh\\s+api\\b.*/pulls/\\d+/merge"], tools: ["mcp__linear__merge_diff"] },
    "yarn PRs merge into master without approval."),
  builtin("pr-reviewers", "reviewers", "Request a reviewer", "deny", { bash: ["\\bgh\\s+pr\\s+(edit|create)\\b.*--(add-)?reviewer\\b", "\\bgh\\s+api\\b.*/requested_reviewers"] },
    "Only he requests reviewers."),
  builtin("pr-open-close", "pr", "Open or close a PR", "allow", { bash: ["\\bgh\\s+pr\\s+(create|close|reopen)\\b"] }, ""),
  builtin("push-default", "push", "Push to a default branch", "allow", { bash: ["\\bgit\\s+push\\b.*\\b(main|master)\\b"] },
    "Agents push yarn straight to master today. Set to Ask me to gate it, or scope a stricter one to a repo."),
  builtin("force-push", "push", "Force-push", "allow", { bash: ["\\bgit\\s+push\\b.*(--force|\\s-f\\b|\\s\\+\\S)"] }, ""),
  builtin("ci-jobs", "jobs", "Start a CI workflow or rerun a job", "allow", { bash: ["\\bgh\\s+(workflow\\s+run|run\\s+rerun)\\b"] }, ""),
  builtin("prod-deploy", "jobs", "Deploy to prod", "ask", { bash: ["\\bgh\\s+workflow\\s+run\\b.*prod", "\\bkubectl\\b.*\\bprod", "\\bhelm\\s+(upgrade|install)\\b.*prod", "\\bmvpd\\b"] },
    "Prod deploys go out on the regular schedule, not to ship one merged fix."),
  builtin("pipeline-runs", "jobs", "Launch a Dagster or Temporal run", "allow", { bash: ["\\bdagster\\b.*\\b(launch|execute|backfill)\\b", "\\btemporal\\s+workflow\\s+(start|execute|signal|terminate|reset)\\b"] },
    "Set to Ask me to gate runs against prod data."),
  builtin("linear", "linear", "Create or edit a Linear ticket", "allow", { tools: ["mcp__linear__(save|create|delete|update|share|unshare|submit|resolve|retire|restore)_.*"] },
    "/dump and /do file tickets on their own."),
  builtin("delete-files", "delete", "Delete files recursively", "allow", { bash: ["\\brm\\s+(-\\S*[rR]|--recursive)"], tools: [`${M365}sharepoint_delete_item`] }, ""),
  builtin("delete-branches", "delete", "Delete a branch", "allow", { bash: ["\\bgit\\s+branch\\s+(-D|--delete|-d)\\b", "\\bgit\\s+push\\b.*(--delete|\\s:\\S)"] }, ""),
  builtin("delete-mail", "delete", "Trash or delete mail", "ask", { tools: [`${GMAIL}trash_(message|thread)`, `${M365}outlook_(trash_thread|batch_delete_messages)`] }, ""),
  builtin("kill-processes", "processes", "Kill processes by pattern", "deny", { bash: ["\\bpkill\\b", "\\bkillall\\b", "\\blsof\\b.*\\|\\s*xargs\\s+kill"] },
    "They match the live yarn, other agents' work and his Chrome. Kill a PID you started."),
  builtin("spend-money", "money", "Spend money", "ask", { bash: ["\\bstripe\\b.*\\b(charges|payment_intents|subscriptions)\\s+create\\b", "\\baws\\b.*\\bpurchase", "\\bgcloud\\b.*\\bbilling\\b"] },
    "Spending money is always his call. Add the matchers for whatever else costs money."),
];

export const FILE = `${STATE_DIR}/restrictions.json`;
// The catalog is seeded once, when the file doesn't exist yet; from then on the file is his, builtins and all.
export function loadRestrictions(file = FILE): Restriction[] {
  if (!existsSync(file)) return saveRestrictions(SEED, file), structuredClone(SEED);
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return structuredClone(SEED); }
}
export const saveRestrictions = (list: Restriction[], file = FILE) => writeFileSync(file, JSON.stringify(list, null, 2));

// Why a restriction can't be saved, or nothing when it can. An override needs no matchers of its own, but a scope it narrows to.
export function invalid(r: Partial<Restriction>, list: Restriction[] = []): string | undefined {
  if (!r.label?.trim()) return "label required";
  if (!r.action?.trim()) return "action required";
  if (!MODES.includes(r.mode as Mode)) return `mode: one of ${MODES.join(", ")}`;
  if (r.parent && !list.some((o) => o.id === r.parent && !o.parent)) return `no restriction ${r.parent} to override`;
  if (r.parent && !r.scope?.objective && !r.scope?.cwd && !r.scope?.people?.length) return "an override needs people, an objective or a folder";
  for (const p of r.scope?.people ?? []) if (!p.team && !p.slack && !p.email && !p.github) return "a person needs a Slack id, an email or a GitHub login";
  const patterns = [...(r.match?.tools ?? []), ...(r.match?.bash ?? [])];
  if (!r.parent && !patterns.length) return "match needs a tools or bash regex";
  for (const p of patterns) try { new RegExp(p); } catch (e) { return `bad regex ${p}: ${(e as Error).message}`; }
}

const home = (path: string) => path.replace(/^~(?=\/|$)/, homedir());
const under = (cwd: string, prefix: string) => {
  const p = home(prefix).replace(/\/+$/, "");
  return cwd === p || cwd.startsWith(`${p}/`);
};
const test = (pattern: string, text: string, whole: boolean) => {
  try { return new RegExp(whole ? `^(?:${pattern})$` : pattern).test(text); } catch { return false; }
};
const lower = (s?: string) => s?.toLowerCase();
export const samePerson = (a: Person, b: Person) =>
  (!!a.slack && a.slack === b.slack) || (!!a.email && lower(a.email) === lower(b.email)) || (!!a.github && lower(a.github) === lower(b.github));
// How closely a restriction's people name this person: by name beats as a teammate, and 0 when they don't cover them.
const personFit = (r: Restriction, who?: Person) => {
  const people = r.scope?.people;
  if (!people?.length) return 1;
  if (!who) return 0;
  return people.some((p) => !p.team && samePerson(p, who)) ? 3 : people.some((p) => p.team) && who.team ? 2 : 0;
};
// Bash patterns test the command with quoted text and heredocs blanked, so a commit message naming `gh pr merge` isn't one.
export const matches = (r: Restriction, call: Call, list: Restriction[] = []) => {
  const m = r.parent ? list.find((o) => o.id === r.parent)?.match : r.match;
  const command = call.tool === "Bash" && typeof call.input?.command === "string" ? shellText(call.input.command) : undefined;
  return !!m && ((m.tools ?? []).some((p) => test(p, call.tool, true)) || (command !== undefined && (m.bash ?? []).some((p) => test(p, command, false))));
};
const applies = (r: Restriction, call: Call, who?: Person) =>
  (!r.scope?.objective || r.scope.objective === call.objective) && (!r.scope?.cwd || (!!call.cwd && under(call.cwd, r.scope.cwd))) && personFit(r, who) > 0;
// A person named is narrower than teammates, both narrower than an objective, an objective narrower than a folder, and a
// deeper folder narrower than a shallower one.
const specificity = (r: Restriction, who?: Person) =>
  (personFit(r, who) === 3 ? 4e6 : personFit(r, who) === 2 ? 2e6 : 0) + (r.scope?.objective ? 1e6 : 0) + (r.scope?.cwd ? home(r.scope.cwd).length + 1 : 0);

type Verdict = { mode: Mode; restriction?: Restriction; person?: Person };
function judge(list: Restriction[], call: Call, who?: Person): Verdict {
  const hits = list.filter((r) => matches(r, call, list) && applies(r, call, who));
  const best = hits.sort((a, b) => specificity(b, who) - specificity(a, who) || MODES.indexOf(b.mode) - MODES.indexOf(a.mode))[0];
  return best ? { mode: best.mode, restriction: best, person: who } : { mode: "allow", person: who };
}
// The mode that governs a tool call: the most specific matching restriction, the strictest among equally specific ones,
// and allow when none matches. A call reaching several people is judged for each of them and gets the strictest verdict,
// so allowing one person never lets through a message that also goes to someone else.
export function resolve(list: Restriction[], call: Call): Verdict {
  const verdicts = call.people?.length ? call.people.map((who) => judge(list, call, who)) : [judge(list, call)];
  return verdicts.reduce((a, b) => (MODES.indexOf(b.mode) > MODES.indexOf(a.mode) ? b : a));
}
export const decide = resolve;
