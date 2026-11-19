import { BASE as base, CLI } from "../instance";
import { LABEL, LOG, restartCommand, status as serviceStatus } from "../service";
import { DIR, run } from "./health-agent";

export type StateAlert = { name: string; problem: string; kept: string; isGating: boolean };

const RULES = `Live runs only committed code, and nobody edits its checkout (${DIR}): a fix to the code goes in your own worktree (\`git -C ${DIR} worktree add ~/Worktrees/maxflow-v2-recovery -b fix/recovery-<what> origin/feat/v2\`), is committed, rebased onto origin/feat/v2 and pushed to feat/v2, and ships with \`${CLI} deploy\`, which refuses a dirty live checkout or a commit whose CI check isn't green. If the live checkout is dirty, don't revert or stash it; find whose it is. Don't kill any tmux session on the maxflow socket; they are the user's running work. When it is fixed, say in a few lines what broke and what you changed.`;
const CURL_STATUS_FORMAT = "%{http_code}";

export function downTask(since: number) {
  const status = serviceStatus().text;
  return `The maxflow server (${DIR}, service ${LABEL}, ${base}) has not answered since ${new Date(since).toLocaleTimeString()}, so the health sentry started you to bring it back. The user is watching you on the health sentry's "down" page, which holds the port until the server asks for it at startup.

The service manager says:
${status}

Last lines of ${LOG}:
${run(["tail", "-n", "80", LOG]).out}

Find the root cause. If the code needs to change, ship the fix with deploy as below; if not, restart with \`${restartCommand}\`. Then confirm \`curl -s ${base}/api/sessions\` answers with the session list. ${RULES}`;
}

export function buildTask(since: number) {
  return `The maxflow frontend (${DIR}/src, bundled by Bun's dev server with hot reload) has failed to build since ${new Date(since).toLocaleTimeString()}: ${base}/ answers 500 "Build Failed" while the API still works, so the user's UI is broken. The health sentry started you to fix it.

Last lines of ${LOG} (the build error is in there):
${run(["tail", "-n", "80", LOG]).out}

Look at \`git -C ${DIR} status\` (an edit made in the live checkout despite the rule: find its owner with \`${CLI} ls\` and \`${CLI} screen <id>\`) and \`git -C ${DIR} log -3\` (a deployed commit that doesn't build). Fix it forward and deploy, as below, then confirm \`curl -s -o /dev/null -w '${CURL_STATUS_FORMAT}' ${base}/\` gives 200. ${RULES}`;
}

export function mcpTask(server: string, error: string) {
  return `Sentries can't reach the MCP server ${server} through the standalone \`mcp\` CLI, even after \`mcp --refresh servers\`: "${error}". The health sentry started you to fix it. Run the /exfilmcp skill (Skill tool, "exfilmcp") to repair the CLI and its connector registry, then confirm with a real read-only \`mcp call ${server} ...\` that it works. If it needs a human reauth in /mcp or on claude.ai, say so exactly, with the steps, and stop. ${RULES}`;
}

export function stateTask({ name, problem, kept, isGating }: StateAlert) {
  const now = isGating ? `The sentry that reads it gates an outward action, so it refuses to start until the file is fixed; the file is untouched at ~/.maxflow-v2/${name}.` : `It was kept as ~/.maxflow-v2/${kept}, and its reader started with an empty ${name}, which it will save over.`;
  return `The state file ~/.maxflow-v2/${name} was unreadable (${problem}). ${now} The health sentry started you to recover it. Find what wrote it badly (git log of the code that writes it, the sentry's log), restore the data from the kept copy if it can be repaired, and tell Isaac in one ${CLI} ask what happened and what you did. ${RULES}`;
}
