import { commandStarts, shellText } from "./restrictions-shell";

// constraint: Isaac is the last step before any agent PR merges, so this gate reads no restrictions file an agent or the UI could loosen
const MERGE_COMMANDS = [/^gh\s+pr\s+merge\b(?![^\n;&|]*--disable-auto)/, /^git\s+push\b[^\n;&|]*[\s:+](main|master)(\s|$)/m];
const MERGE_ANYWHERE = [/\/pulls\/\d+\/merge\b/, /\brepos\/[\w.-]+\/[\w.-]+\/merges\b/, /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/, /\/api\/prs\/merge\b/];
const MERGE_TOOLS = [/^mcp__linear__merge_diff$/, /^mcp__.*github.*__(merge_pull_request|enable_auto_merge|.*automerge.*)$/i];

export const MERGE_REFUSAL =
  "Blocked by yarn's merge gate: Isaac is the last step before any PR merges, so no agent or sentry merges a PR, arms auto-merge or pushes straight to main or master, in any repo. Get it green, reviewed and approved, then leave the merge to him (he merges from the PR queue in yarn). Don't retry it or work around it with another tool, token or script.";

function isMergeCommand(command: string) {
  const shown = shellText(command);
  const isAtACommandStart = commandStarts(shown).some((at) => MERGE_COMMANDS.some((re) => re.test(shown.slice(at))));
  return isAtACommandStart || MERGE_ANYWHERE.some((re) => re.test(command));
}

export function isMergeCall(tool: string, input: Record<string, unknown> | undefined) {
  if (MERGE_TOOLS.some((re) => re.test(tool))) return true;
  const command = input?.["command"];
  return tool === "Bash" && typeof command === "string" && isMergeCommand(command);
}
