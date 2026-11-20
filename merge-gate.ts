import { isRecord } from "./shared/guards";
import { commandStarts, shellText } from "./restrictions-shell";
import { readStateJson, writeStateJson } from "./state";

// constraint: the gate is a switch only Isaac flips (his browser, routes-prs.ts); the editable pr-merge restriction can't loosen it while it is on
export const GATE_FILE = "merge-gate.json";
export type MergeGate = { on: boolean; at: number };

const MERGE_COMMANDS = [/^gh\s+pr\s+merge\b(?![^\n;&|]*--disable-auto)/];
const PUSH_TO_MAIN = /^git\s+push\b[^\n;&|]*[\s:+](main|master)(\s|$)/m;
// constraint: ~/Timelines is an auto-committed log with no PRs, so it pushes to main with the gate on
const NO_PR_REPO = /(^|\/)Timelines(\/|$|\s)/;
const MERGE_ANYWHERE = [
  /\/pulls\/\d+\/merge\b/, /\brepos\/[\w.-]+\/[\w.-]+\/merges\b/, /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/,
  /(localhost|127\.0\.0\.1|(?:YARN|MAXFLOW)_PORT\}?|:\d{2,5})\S*\/api\/prs\/merge\b/,
];
const MERGE_TOOLS = [/^mcp__linear__merge_diff$/, /^mcp__.*github.*__(merge_pull_request|enable_auto_merge|.*automerge.*)$/i];
const SWITCH_WRITE = [/(>|\b(tee|rm|mv|cp|ln|truncate|touch|unlink)\b|\bsed\s+-i|\bperl\s+-[a-z]*i)[^\n;&|]*merge-gate\.json/, /\/api\/merge-gate\b[^\n]*(-d\b|--data|-X\s*(POST|PUT|PATCH))|(-d\b|--data|-X\s*(POST|PUT|PATCH))[^\n]*\/api\/merge-gate\b/];
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export const MERGE_REFUSAL =
  "Blocked by yarn's merge gate: Isaac has it on, so he is the last step before any PR merges, and no agent or sentry merges a PR, arms auto-merge or pushes straight to main or master, in any repo. The gate is a switch only he flips (the PRs tab, or Restrictions); never ask to have it turned off for one PR. Get the PR green, reviewed and approved and leave the merge to him. Don't retry it or work around it with another tool, token or script.";
export const SWITCH_REFUSAL = "Blocked: the merge gate is Isaac's switch, flipped only from his browser (the PRs tab, or Restrictions). No agent changes it, either way.";

const isGate = (value: unknown): value is MergeGate => isRecord(value) && typeof value["on"] === "boolean";

export const mergeGate = (): MergeGate => readStateJson(GATE_FILE, isGate) ?? { on: false, at: 0 };

export function setMergeGate(isOn: boolean): MergeGate {
  const gate = { on: isOn, at: Date.now() };
  writeStateJson(GATE_FILE, gate);
  return gate;
}

function isMergeCommand(command: string, cwd = "") {
  const shown = shellText(command);
  const isNoPrRepo = NO_PR_REPO.test(cwd) || NO_PR_REPO.test(command);
  const gated = isNoPrRepo ? MERGE_COMMANDS : [...MERGE_COMMANDS, PUSH_TO_MAIN];
  const isAtACommandStart = commandStarts(shown).some((at) => gated.some((re) => re.test(shown.slice(at))));
  return isAtACommandStart || MERGE_ANYWHERE.some((re) => re.test(command));
}

export function isMergeCall(tool: string, input: Record<string, unknown> | undefined, cwd?: string) {
  if (MERGE_TOOLS.some((re) => re.test(tool))) return true;
  const command = input?.["command"];
  return tool === "Bash" && typeof command === "string" && isMergeCommand(command, cwd);
}

export function isSwitchWrite(tool: string, input: Record<string, unknown> | undefined) {
  const path = input?.["file_path"] ?? input?.["notebook_path"];
  if (EDIT_TOOLS.has(tool)) return typeof path === "string" && path.endsWith(GATE_FILE);
  const command = input?.["command"];
  return tool === "Bash" && typeof command === "string" && SWITCH_WRITE.some((re) => re.test(command));
}

type GatedCall = { tool: string; input?: Record<string, unknown> | undefined; cwd?: string | undefined };

export function gateRefusal({ tool, input, cwd }: GatedCall, gate = mergeGate()) {
  if (isSwitchWrite(tool, input)) return SWITCH_REFUSAL;
  return gate.on && isMergeCall(tool, input, cwd) ? MERGE_REFUSAL : undefined;
}
