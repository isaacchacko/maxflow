import { tmuxAsync } from "./tmux";
import { type Session, isAgent, isSentry, sessions } from "./sessions";
import { setClaudeState, stopAgent } from "./lifecycle";
import { patch } from "./patch";
import { isFilled } from "./shared/guards";

const CLAUDE_CHECK_MS = 5000;
const MOST_PROCESSES_IN_A_PANE = 500;
const CLAUDE_COMMAND_LINE = /^(\S*\/)?claude(\s|$)|claude-code|@anthropic-ai\/claude/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;

type ProcessTable = { childrenOf: Map<number, number[]>; commandLineOf: Map<number, string> };

async function readProcessTable(): Promise<ProcessTable> {
  const ps = Bun.spawn(["ps", "-Ao", "pid=,ppid=,args="], { stdout: "pipe" });
  const out = await new Response(ps.stdout).text();
  const table: ProcessTable = { childrenOf: new Map(), commandLineOf: new Map() };
  for (const line of out.split("\n")) {
    const [, pidText, parentText, commandLine = ""] = PS_LINE.exec(line) ?? [];
    if (pidText === undefined || parentText === undefined) continue;
    const pid = Number(pidText);
    const parent = Number(parentText);
    table.commandLineOf.set(pid, commandLine.trim());
    table.childrenOf.set(parent, [...(table.childrenOf.get(parent) ?? []), pid]);
  }
  return table;
}

function processTreeOf(pid: number, table: ProcessTable): number[] {
  const tree = [pid];
  for (let i = 0; i < tree.length && tree.length < MOST_PROCESSES_IN_A_PANE; i++) tree.push(...(table.childrenOf.get(tree[i] ?? 0) ?? []));
  return tree;
}

const isCheckedAgent = (s: Session | undefined): s is Session => s !== undefined && !isSentry(s) && isAgent(s) && s.exitCode === null;

function checkPane(line: string, table: ProcessTable) {
  const [name = "", pid = ""] = line.split(" ");
  const s = sessions.get(name.replace(/^mf-/, ""));
  if (pid === "" || !isCheckedAgent(s)) return;
  const isClaudeUp = processTreeOf(Number(pid), table).some((p) => CLAUDE_COMMAND_LINE.test(table.commandLineOf.get(p) ?? ""));
  patch(s, { claudeUp: isClaudeUp });
  if (!isClaudeUp && s.claude) setClaudeState(s, "gone");
  if (isClaudeUp && s.archived === true && !isFilled(s.asleep) && s.claude?.state === "idle") void stopAgent(s);
}

async function checkClaudeRunsInEachAgentPane() {
  const table = await readProcessTable();
  for (const line of (await tmuxAsync("list-panes", "-a", "-F", "#{session_name} #{pane_pid}")).out.split("\n")) checkPane(line, table);
}

export function keepCheckingClaudeRunsInEachAgentPane() {
  setInterval(() => {
    checkClaudeRunsInEachAgentPane().catch((error: unknown) => {
      console.error("checkClaude", error);
    });
  }, CLAUDE_CHECK_MS);
}
