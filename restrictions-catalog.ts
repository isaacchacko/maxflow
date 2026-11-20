import { DIR } from "./instance";
import type { Exception, Mode, Reach, Restriction } from "./shared/restrictions-types";

const SLACK = "mcp__claude_ai_Slack__";
const GMAIL = "mcp__claude_ai_Gmail__";
const M365 = "mcp__claude_ai_Microsoft_365__";

type BuiltinHead = [id: string, action: string, label: string, mode: Mode];
type PersonReach = [reaches: Reach, forPerson: string];

const builtin = ([id, action, label, mode]: BuiltinHead, match: Restriction["match"], note: string, reach?: PersonReach): Restriction => ({
  id,
  action,
  label,
  mode,
  match,
  note,
  builtin: true,
  ...(reach && { reaches: reach[0], forPerson: reach[1] }),
});

const outsidersAskFirst = (parent: string, action: string, label: string, note: string): Restriction => ({
  id: `${parent}-outsiders`,
  action,
  label,
  mode: "ask",
  match: {},
  parent,
  scope: { people: [{ team: false, name: "Outsiders" }] },
  note,
  builtin: true,
});

type Explain = Required<Pick<Restriction, "about" | "examples" | "noun">> & { exceptions: Exception[] };
export const CATALOG_WORDS: Record<string, Explain> = {
  slack: { about: "Sending or scheduling a Slack message, to a person or a channel. A draft you send yourself isn't covered.", examples: ["An agent DMs Felix on Slack", "An agent posts an update in #arch_comms"], noun: "message", exceptions: ["people", "objective"] },
  email: { about: "Sending, replying to or forwarding an email from Gmail or Outlook. Drafts aren't covered.", examples: ["An agent replies to a supplier's email"], noun: "email", exceptions: ["people", "objective"] },
  board: { about: "Writing on a Vercel Board: posting, replying, reacting, labelling, editing or deleting a message, working a task, or changing channels and grants. Reading and waiting aren't covered.", examples: ["An agent replies to Max's agent on the Dryft board", "An agent claims a task on the board"], noun: "write", exceptions: ["objective"] },
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
  "gh-poll": { about: "Watching a CI run with gh run watch, which asks GitHub every 3 seconds unless given --interval 30 or more.", examples: ["An agent runs gh run watch on its branch's check"], noun: "watch", exceptions: [] },
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
export const SEED: Restriction[] = [
  builtin(["slack", "message", "Message a person on Slack", "ask"], { tools: [`${SLACK}slack_send_message`, `${SLACK}slack_schedule_message`] },
    "Outward-facing: a message he has not asked for waits on him, teammates included, since it goes out in his name. Drafts are not covered.", ["slack", "Message {name} on Slack"]),
  builtin(["email", "message", "Send or reply to an email", "ask"], { tools: [`${GMAIL}(send_message|reply|forward)`, `${M365}outlook_(send_mail|send_draft|forward_mail)`] },
    "Gmail and Outlook. Drafts are not covered.", ["email", "Email {name}"]),
  builtin(["teams", "message", "Message someone on Teams", "ask"], { tools: [`${M365}teams_(send_chat_message|send_channel_message|reply_channel_message|create_chat)`] },
    "A person is known only when the agent starts a chat with them, by their address.", ["email", "Message {name} on Teams"]),
  builtin(["board", "message", "Write on a Vercel Board", "ask"], { bash: ["\\b((npx|bunx|pnpm\\s+dlx|yarn\\s+dlx)(\\s+-\\S+)*\\s+)?(vercel(@\\S+)?\\s+board|dboard|vb|@vercel/board(@\\S+)?)\\s+(post|reply|schedule|edit|delete|react|label|typing|sync|tasks\\s+(create|claim|renew|complete|fail|release|block|assign|cancel)|grants\\s+(create|update|revoke)|channels\\s+create)\\b"] },
    "Teammates and their agents read the board, and a synced thread reaches Slack, GitHub or Linear, in his name."),
  builtin(["mallory-phone", "message", "Mallory to your phone", "ask"], { bash: ["\\bmallory\\s+send\\b.*--to\\s+(umbrella|all)\\b"] },
    "umbrella is his phone, with no agent: he reads it. Only he is on the other end, so it is never set per person. Agent-to-agent mallory is not covered."),
  builtin(["calendar", "message", "Create or answer a calendar event", "ask"], { tools: [`${M365}outlook_(create_event|update_event|delete_event|respond_to_event)`] },
    "Invites reach other people, by their address.", ["email", "Invite {name} to events"]),
  builtin(["pr-comment", "review", "Comment on or review a PR", "allow"], { bash: ["\\bgh\\s+pr\\s+comment\\b", "\\bgh\\s+pr\\s+review\\b(?!.*(--approve|\\s-a\\b))", "\\bgh\\s+api\\b.*/pulls/\\d+/(comments|reviews)"] },
    "Approving is its own restriction. An outsider's PR asks first: a comment there is public, in his name.", ["github", "Comment on or review {name's} PRs"]),
  builtin(["pr-approve", "approve", "Approve a PR", "allow"], { bash: ["\\bgh\\s+pr\\s+review\\b.*(--approve|\\s-a\\b)"] },
    "An agent that read the diff and found it good approves a teammate's PR, as him; an outsider's asks first.", ["github", "Approve {name's} PRs"]),
  builtin(["pr-merge", "merge", "Merge a PR or arm auto-merge", "allow"], { bash: ["\\bgh\\s+pr\\s+merge\\b", "\\bgh\\s+api\\b.*/pulls/\\d+/merge"], tools: ["mcp__linear__merge_diff"] },
    "Isaac merges every PR himself: yarn's merge gate blocks agents from merging or arming auto-merge whatever this is set to.", ["github", "Merge {name's} PRs"]),
  builtin(["pr-reviewers", "reviewers", "Request a reviewer", "deny"], { bash: ["\\bgh\\s+pr\\s+(edit|create)\\b.*--(add-)?reviewer\\b", "\\bgh\\s+api\\b.*/requested_reviewers"] },
    "Only he requests reviewers, whoever they are, so it is never set per person."),
  builtin(["pr-open-close", "pr", "Open or close a PR", "allow"], { bash: ["\\bgh\\s+pr\\s+(create|close|reopen)\\b"] }, ""),
  builtin(["push-default", "push", "Push to a default branch", "allow"], { bash: ["\\bgit\\s+push\\b.*\\b(main|master)\\b"] },
    "Agents push yarn straight to master today. Set to Ask me to gate it, or scope a stricter one to a repo."),
  builtin(["force-push", "push", "Force-push", "allow"], { bash: ["\\bgit\\s+push\\b.*(--force|\\s-f\\b|\\s\\+\\S)"] }, ""),
  builtin(["ci-jobs", "jobs", "Start a CI workflow or rerun a job", "allow"], { bash: ["\\bgh\\s+(workflow\\s+run|run\\s+rerun)\\b"] }, ""),
  builtin(["gh-poll", "jobs", "Poll a CI run every few seconds", "deny"], { bash: ["\\bgh\\s+run\\s+watch\\b(?!.*(--interval|\\s-i)[\\s=]+([3-9]\\d|\\d{3,})\\b)"] },
    "Every agent, sentry and his own work share one 5,000-an-hour GitHub budget, and three default watchers emptied it. Wait with cli.ts wait ci:<pr | branch | sha>, answered from the gh sentry's poll, or pass --interval 30."),
  builtin(["prod-deploy", "jobs", "Deploy to prod", "ask"], { bash: ["\\bgh\\s+workflow\\s+run\\b.*prod", "\\bkubectl\\b.*\\bprod", "\\bhelm\\s+(upgrade|install)\\b.*prod", "\\bmvpd\\b"] },
    "Prod deploys go out on the regular schedule, not to ship one merged fix."),
  builtin(["pipeline-runs", "jobs", "Launch a Dagster or Temporal run", "allow"], { bash: ["\\bdagster\\b.*\\b(launch|execute|backfill)\\b", "\\btemporal\\s+workflow\\s+(start|execute|signal|terminate|reset)\\b"] },
    "Set to Ask me to gate runs against prod data."),
  builtin(["linear", "linear", "Create or edit a Linear ticket", "allow"], { tools: ["mcp__linear__(save|create|delete|update|share|unshare|submit|resolve|retire|restore)_.*"] },
    "/dump and /do file tickets on their own."),
  builtin(["delete-files", "delete", "Delete files recursively", "allow"], { bash: ["\\brm\\s+(-\\S*[rR]|--recursive)"], tools: [`${M365}sharepoint_delete_item`] }, ""),
  builtin(["delete-branches", "delete", "Delete a branch", "allow"], { bash: ["\\bgit\\s+branch\\s+(-D|--delete|-d)\\b", "\\bgit\\s+push\\b.*(--delete|\\s:\\S)"] }, ""),
  builtin(["delete-mail", "delete", "Trash or delete mail", "ask"], { tools: [`${GMAIL}trash_(message|thread)`, `${M365}outlook_(trash_thread|batch_delete_messages)`] }, ""),
  builtin(["edit-live", "yarn", "Edit the live yarn checkout", "deny"], { tools: ["Edit", "Write", "MultiEdit", "NotebookEdit"], paths: [`^${DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`] },
    "Live runs only committed code: change yarn in your own worktree, push to feat/v2, and ship it with cli.ts deploy."),
  builtin(["kill-processes", "processes", "Kill processes by pattern", "deny"], { bash: ["\\bpkill\\b", "\\bkillall\\b", "\\blsof\\b.*\\|\\s*xargs\\s+kill"] },
    "They match the live yarn, other agents' work and his Chrome. Kill a PID you started."),
  outsidersAskFirst("pr-comment", "review", "Comment on or review a PR", "A PR from outside the team: a comment there is public."),
  outsidersAskFirst("pr-approve", "approve", "Approve a PR", "Approving a PR from outside the team vouches for it publicly."),
  outsidersAskFirst("pr-merge", "merge", "Merge a PR or arm auto-merge", "Merging a PR from outside the team ships code nobody on it wrote."),
  builtin(["spend-money", "money", "Spend money", "ask"], { bash: ["\\bstripe\\b.*\\b(charges|payment_intents|subscriptions)\\s+create\\b", "\\baws\\b.*\\bpurchase", "\\bgcloud\\b.*\\bbilling\\b"] },
    "Spending money is always his call. Add the matchers for whatever else costs money."),
];
for (const r of SEED) {
  const words = CATALOG_WORDS[r.id];
  if (words !== undefined) Object.assign(r, words);
}
