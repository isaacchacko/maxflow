import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { DIR, STATE_DIR } from "./instance";
import { commandStarts, shellText } from "./restrictions-shell";

// His autonomy restrictions: what his agents may do on their own (allow), must ask him first (ask), or may never do (deny).
// The server serves and edits them (/api/restrictions), the Restrictions page shows them, and the enforcement hook
// (hooks/restrictions.ts) runs resolve() on every tool call. This module reads and writes no server state, so the hook
// and the CLI can import it alone.
export const MODES = ["allow", "ask", "deny"] as const;
export type Mode = (typeof MODES)[number];
// match.tools: regexes on the whole Claude Code tool_name; match.bash: regexes matched where a command
// in a Bash command starts (commandStarts), so a file named pkill.md isn't pkill; match.paths: regexes on the file a
// matched tool writes (file_path or notebook_path), which a tools match then also needs.
// scope: it applies only on that objective, only under that path prefix, and only to those people; no scope applies everywhere.
// parent: an override of another restriction, for some people or some place, which uses that one's matchers instead of its own.
// reaches: the account the person on the other end of the call is known by (a Slack message's recipient, an email's, a PR's
// author); only a restriction that reaches someone can be set per person. forPerson: its label said of one person, {name}
// standing for their name and {name's} for its possessive ("Approve {name's} PRs").
export type Reach = "slack" | "email" | "github";
// people: some people or Teammates/Outsiders; objective: one objective's agents; repo: calls made inside one repository.
export type Exception = "people" | "objective" | "repo";
export type Restriction = {
  id: string;
  action: string;
  label: string;
  mode: Mode;
  match: { tools?: string[]; bash?: string[]; paths?: string[] };
  scope?: { objective?: string; cwd?: string; people?: Person[] };
  parent?: string;
  reaches?: Reach;
  forPerson?: string;
  // The catalog's own words for a builtin: what it covers, examples of it, what one of it is called ("message"), and the
  // exceptions he can carve out of it. His own rules carry about (his description) and nothing else.
  about?: string;
  examples?: string[];
  noun?: string;
  exceptions?: Exception[];
  note?: string;
  builtin?: boolean;
};
// Someone a call reaches: a message's recipient, a PR's author. Any shared id is the same person; in a restriction's scope,
// {team: true} stands for every teammate and {team: false} for everyone known not to be one (an outsider).
export type Person = { name?: string; slack?: string; email?: string; github?: string; team?: boolean };
// people: who the call reaches, as the hook reads them from its input; none for a call that reaches no one in particular.
export type Call = { tool: string; input?: Record<string, unknown>; cwd?: string; objective?: string; people?: Person[] };

const SLACK = "mcp__claude_ai_Slack__";
const GMAIL = "mcp__claude_ai_Gmail__";
const M365 = "mcp__claude_ai_Microsoft_365__";
const builtin = (id: string, action: string, label: string, mode: Mode, match: Restriction["match"], note: string, reach?: [Reach, string]): Restriction =>
  ({ id, action, label, mode, match, note, builtin: true, ...(reach && { reaches: reach[0], forPerson: reach[1] }) });
const outsiders = (parent: string, action: string, label: string, mode: Mode, note: string): Restriction =>
  ({ id: `${parent}-outsiders`, action, label, mode, match: {}, parent, scope: { people: [{ team: false, name: "Outsiders" }] }, note, builtin: true });

// The catalog he starts with, seeded from his standing rules so nothing that works today breaks on day one:
// approving and merging PRs is allowed, an outward-facing message to a person asks him first, and what he has
// already forbidden (requesting reviewers, killing processes by pattern) is blocked. action is the kind the page groups by.
export const SEED: Restriction[] = [
  builtin("slack", "message", "Message a person on Slack", "ask", { tools: [`${SLACK}slack_send_message`, `${SLACK}slack_schedule_message`] },
    "Outward-facing: a message he has not asked for waits on him, teammates included, since it goes out in his name. Drafts are not covered.", ["slack", "Message {name} on Slack"]),
  builtin("email", "message", "Send or reply to an email", "ask", { tools: [`${GMAIL}(send_message|reply|forward)`, `${M365}outlook_(send_mail|send_draft|forward_mail)`] },
    "Gmail and Outlook. Drafts are not covered.", ["email", "Email {name}"]),
  builtin("teams", "message", "Message someone on Teams", "ask", { tools: [`${M365}teams_(send_chat_message|send_channel_message|reply_channel_message|create_chat)`] },
    "A person is known only when the agent starts a chat with them, by their address.", ["email", "Message {name} on Teams"]),
  builtin("mallory-phone", "message", "Mallory to your phone", "ask", { bash: ["\\bmallory\\s+send\\b.*--to\\s+(umbrella|all)\\b"] },
    "umbrella is his phone, with no agent: he reads it. Only he is on the other end, so it is never set per person. Agent-to-agent mallory is not covered."),
  builtin("calendar", "message", "Create or answer a calendar event", "ask", { tools: [`${M365}outlook_(create_event|update_event|delete_event|respond_to_event)`] },
    "Invites reach other people, by their address.", ["email", "Invite {name} to events"]),
  builtin("pr-comment", "review", "Comment on or review a PR", "allow", { bash: ["\\bgh\\s+pr\\s+comment\\b", "\\bgh\\s+pr\\s+review\\b(?!.*(--approve|\\s-a\\b))", "\\bgh\\s+api\\b.*/pulls/\\d+/(comments|reviews)"] },
    "Approving is its own restriction. An outsider's PR asks first: a comment there is public, in his name.", ["github", "Comment on or review {name's} PRs"]),
  builtin("pr-approve", "approve", "Approve a PR", "allow", { bash: ["\\bgh\\s+pr\\s+review\\b.*(--approve|\\s-a\\b)"] },
    "An agent that read the diff and found it good approves a teammate's PR, as him; an outsider's asks first.", ["github", "Approve {name's} PRs"]),
  builtin("pr-merge", "merge", "Merge a PR or arm auto-merge", "allow", { bash: ["\\bgh\\s+pr\\s+merge\\b", "\\bgh\\s+api\\b.*/pulls/\\d+/merge"], tools: ["mcp__linear__merge_diff"] },
    "yarn PRs merge into master without approval; an outsider's PR asks first.", ["github", "Merge {name's} PRs"]),
  builtin("pr-reviewers", "reviewers", "Request a reviewer", "deny", { bash: ["\\bgh\\s+pr\\s+(edit|create)\\b.*--(add-)?reviewer\\b", "\\bgh\\s+api\\b.*/requested_reviewers"] },
    "Only he requests reviewers, whoever they are, so it is never set per person."),
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
  builtin("edit-live", "yarn", "Edit the live yarn checkout", "deny", { tools: ["Edit", "Write", "MultiEdit", "NotebookEdit"], paths: [`^${DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`] },
    "Live runs only committed code: change yarn in your own worktree, push to feat/v2, and ship it with cli.ts deploy."),
  builtin("kill-processes", "processes", "Kill processes by pattern", "deny", { bash: ["\\bpkill\\b", "\\bkillall\\b", "\\blsof\\b.*\\|\\s*xargs\\s+kill"] },
    "They match the live yarn, other agents' work and his Chrome. Kill a PID you started."),
  outsiders("pr-comment", "review", "Comment on or review a PR", "ask", "A PR from outside the team: a comment there is public."),
  outsiders("pr-approve", "approve", "Approve a PR", "ask", "Approving a PR from outside the team vouches for it publicly."),
  outsiders("pr-merge", "merge", "Merge a PR or arm auto-merge", "ask", "Merging a PR from outside the team ships code nobody on it wrote."),
  builtin("spend-money", "money", "Spend money", "ask", { bash: ["\\bstripe\\b.*\\b(charges|payment_intents|subscriptions)\\s+create\\b", "\\baws\\b.*\\bpurchase", "\\bgcloud\\b.*\\bbilling\\b"] },
    "Spending money is always his call. Add the matchers for whatever else costs money."),
];

type Explain = Required<Pick<Restriction, "about" | "examples" | "noun">> & { exceptions: Exception[] };
const EXPLAIN: Record<string, Explain> = {
  slack: { about: "Sending or scheduling a Slack message, to a person or a channel. A draft you send yourself isn't covered.", examples: ["An agent DMs Felix on Slack", "An agent posts an update in #arch_comms"], noun: "message", exceptions: ["people", "objective"] },
  email: { about: "Sending, replying to or forwarding an email from Gmail or Outlook. Drafts aren't covered.", examples: ["An agent replies to a supplier's email"], noun: "email", exceptions: ["people", "objective"] },
  teams: { about: "Sending a Teams chat or channel message, or starting a chat.", examples: ["An agent messages Christoph on Teams"], noun: "message", exceptions: ["people", "objective"] },
  "mallory-phone": { about: "A mallory message to your phone (umbrella) or to every device. Messages between your agents aren't covered.", examples: ["An agent pings your phone that a deploy finished"], noun: "message", exceptions: ["objective"] },
  calendar: { about: "Creating, changing, cancelling or answering a calendar event.", examples: ["An agent invites Felix to a review call", "An agent accepts a meeting for you"], noun: "change", exceptions: ["people", "objective"] },
  "pr-comment": { about: "Commenting on a pull request, or leaving a review that isn't an approval.", examples: ["An agent leaves review comments on Felix's PR"], noun: "comment", exceptions: ["people", "objective"] },
  "pr-approve": { about: "Approving a pull request on GitHub, as you.", examples: ["An agent approves Zelda's PR after reading the diff"], noun: "approval", exceptions: ["people", "objective"] },
  "pr-merge": { about: "Merging a pull request, or turning on auto-merge so it merges once checks pass.", examples: ["An agent merges a yarn PR once CI is green"], noun: "merge", exceptions: ["people", "objective"] },
  "pr-reviewers": { about: "Asking someone to review a pull request.", examples: ["An agent requests Felix as a reviewer"], noun: "request", exceptions: [] },
  "pr-open-close": { about: "Opening, closing or reopening a pull request.", examples: ["An agent opens a PR for its fix"], noun: "change", exceptions: ["repo", "objective"] },
  "push-default": { about: "Pushing commits straight to main or master, skipping a pull request.", examples: ["An agent pushes a yarn change to master"], noun: "push", exceptions: ["repo"] },
  "force-push": { about: "Force-pushing, which rewrites a branch's history on GitHub.", examples: ["An agent force-pushes its rebased branch"], noun: "push", exceptions: ["repo"] },
  "ci-jobs": { about: "Starting a GitHub Actions workflow, or re-running a job.", examples: ["An agent re-runs a flaky test job"], noun: "run", exceptions: ["repo", "objective"] },
  "prod-deploy": { about: "Deploying to production.", examples: ["An agent dispatches the prod deploy workflow"], noun: "deploy", exceptions: ["objective"] },
  "pipeline-runs": { about: "Launching, backfilling or changing a Dagster or Temporal run.", examples: ["An agent backfills a Dagster partition", "An agent starts a Temporal workflow"], noun: "run", exceptions: ["objective"] },
  linear: { about: "Creating, editing or deleting Linear tickets, comments and documents.", examples: ["An agent files a ticket for a bug it found"], noun: "change", exceptions: ["objective"] },
  "delete-files": { about: "Deleting a folder and everything in it (rm -r), or a SharePoint item.", examples: ["An agent deletes a build folder"], noun: "delete", exceptions: ["repo"] },
  "delete-branches": { about: "Deleting a git branch, on your machine or on GitHub.", examples: ["An agent deletes its merged branch"], noun: "delete", exceptions: ["repo"] },
  "delete-mail": { about: "Moving emails to the trash.", examples: ["An agent trashes a newsletter"], noun: "delete", exceptions: ["objective"] },
  "edit-live": { about: "Editing a file in the checkout the live yarn runs from. Changes go through a worktree and cli.ts deploy.", examples: ["An agent edits server.ts in ~/Worktrees/maxflow-v2"], noun: "edit", exceptions: [] },
  "kill-processes": { about: "Killing processes by name or pattern (pkill, killall) instead of the one process it started.", examples: ["An agent runs pkill -f bun"], noun: "kill", exceptions: [] },
  "spend-money": { about: "Anything that charges money: Stripe charges, cloud purchases, billing changes.", examples: ["An agent buys an AWS reservation"], noun: "purchase", exceptions: [] },
};
for (const r of SEED) if (EXPLAIN[r.id]) Object.assign(r, EXPLAIN[r.id]);

export const FILE = `${STATE_DIR}/restrictions.json`;
// The catalog is seeded once, when the file doesn't exist yet; from then on the file is his, builtins and all. A builtin added
// to the catalog later is seeded once too, so one he deleted stays deleted (restrictions-seeded.json keeps which were seeded).
// Who a builtin reaches and how it reads for one person are the catalog's, not his, and follow it.
export function loadRestrictions(file = FILE): Restriction[] {
  const seededFile = file.replace(/\.json$/, "-seeded.json");
  if (!existsSync(file)) return saveRestrictions(SEED, file), writeFileSync(seededFile, JSON.stringify(SEED.map((r) => r.id))), structuredClone(SEED);
  let list: Restriction[];
  try { list = JSON.parse(readFileSync(file, "utf8")); } catch { return structuredClone(SEED); }
  const seeded = new Set<string>((() => { try { return JSON.parse(readFileSync(seededFile, "utf8")); } catch { return list.map((r) => r.id); } })());
  for (const s of SEED) {
    const r = list.find((o) => o.id === s.id);
    if (r) {
      if (s.reaches) (r.reaches = s.reaches), (r.forPerson = s.forPerson);
      else delete r.reaches, delete r.forPerson;
      if (EXPLAIN[s.id]) Object.assign(r, EXPLAIN[s.id]);
      if (s.id === "mallory-phone" && r.label === "Mallory to his phone") r.label = s.label;
    } else if (!seeded.has(s.id) && (!s.parent || list.some((o) => o.id === s.parent))) list.push(structuredClone(s));
    seeded.add(s.id);
  }
  writeFileSync(seededFile, JSON.stringify([...seeded]));
  saveRestrictions(list, file);
  return list;
}
export const saveRestrictions = (list: Restriction[], file = FILE) => writeFileSync(file, JSON.stringify(list, null, 2));

// Why a restriction can't be saved, or nothing when it can. An override needs no matchers of its own, but a scope it narrows to.
export function invalid(r: Partial<Restriction>, list: Restriction[] = []): string | undefined {
  if (!r.label?.trim()) return "label required";
  if (!r.action?.trim()) return "action required";
  if (!MODES.includes(r.mode as Mode)) return `mode: one of ${MODES.join(", ")}`;
  if (r.reaches && !["slack", "email", "github"].includes(r.reaches)) return "reaches: slack, email or github";
  if (r.parent && !list.some((o) => o.id === r.parent && !o.parent)) return `no restriction ${r.parent} to override`;
  if (r.parent && !r.scope?.objective && !r.scope?.cwd && !r.scope?.people?.length) return "an override needs people, an objective or a folder";
  const reaches = r.parent ? list.find((o) => o.id === r.parent)?.reaches : r.reaches;
  if (r.scope?.people?.length && !reaches) return "nobody is on the other end of this action, so it can't be set per person";
  for (const p of r.scope?.people ?? []) if (p.team === undefined && !p.slack && !p.email && !p.github) return "a person needs a Slack id, an email or a GitHub login";
  const patterns = [...(r.match?.tools ?? []), ...(r.match?.bash ?? []), ...(r.match?.paths ?? [])];
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
// How closely a restriction's people name this person: by name beats as a teammate or an outsider, and 0 when they don't
// cover them. Someone not known to be either is covered by neither group.
const personFit = (r: Restriction, who?: Person) => {
  const people = r.scope?.people;
  if (!people?.length) return 1;
  if (!who) return 0;
  return people.some((p) => p.team === undefined && samePerson(p, who)) ? 3 : people.some((p) => p.team !== undefined && p.team === who.team) ? 2 : 0;
};
const testAt = (pattern: string, text: string, starts: number[]) => {
  try {
    const re = new RegExp(pattern, "y");
    return starts.some((s) => ((re.lastIndex = s), re.test(text)));
  } catch { return false; }
};
// Bash patterns test the command with quoted text and heredocs blanked, so a commit message naming `gh pr merge` isn't one,
// and only where a command starts, so `cat live-watch-and-pkill.md` isn't pkill.
export const matches = (r: Restriction, call: Call, list: Restriction[] = []) => {
  const m = r.parent ? list.find((o) => o.id === r.parent)?.match : r.match;
  const command = call.tool === "Bash" && typeof call.input?.command === "string" ? shellText(call.input.command) : undefined;
  const starts = command === undefined ? [] : commandStarts(command);
  const path = call.input?.file_path ?? call.input?.notebook_path;
  const onPath = !m?.paths?.length || (typeof path === "string" && m.paths.some((p) => test(p, path, false)));
  return !!m && (((m.tools ?? []).some((p) => test(p, call.tool, true)) && onPath) || (command !== undefined && (m.bash ?? []).some((p) => testAt(p, command, starts))));
};
const applies = (r: Restriction, call: Call, who?: Person) =>
  (!r.scope?.objective || r.scope.objective === call.objective) && (!r.scope?.cwd || (!!call.cwd && under(call.cwd, r.scope.cwd))) && personFit(r, who) > 0;
// A person named is narrower than teammates or outsiders, both narrower than an objective, an objective narrower than a folder, and a
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
