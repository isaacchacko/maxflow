const RECENT_SHELL_MS = 12 * 3_600_000;
const RECENT_SUBAGENT_MS = 48 * 3_600_000;
const TRANSCRIPT_TAIL_BYTES = 2_000_000;

const capturedIds = (line: string, pattern: RegExp) => line.matchAll(pattern).map((match) => match[1] ?? "");

const isRecent = (line: string, ms: number) => Date.now() - Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? "") < ms;
const isRecentShellStart = (line: string) => line.includes('"backgroundTaskId"') && isRecent(line, RECENT_SHELL_MS);
const isRecentSubagentStart = (line: string) => line.includes('"status":"async_launched"') && isRecent(line, RECENT_SUBAGENT_MS);

function stillRunning(tail: string, isStart: (line: string) => boolean, startId: RegExp) {
  const running = new Set<string>();
  for (const line of tail.split("\n")) {
    if (isStart(line)) for (const id of capturedIds(line, startId)) running.add(id);
    for (const id of capturedIds(line, /<task-id>(\w+)<\/task-id>/g)) running.delete(id);
  }
  return running;
}
export const backgroundShells = (tail: string) => stillRunning(tail, isRecentShellStart, /"backgroundTaskId":"(\w+)"/g);
// constraint: Claude Code logs a background subagent's launch as status async_launched with its agentId, and its end as a <task-notification> naming it
export const backgroundSubagents = (tail: string) => stillRunning(tail, isRecentSubagentStart, /"agentId":"(\w+)"/g);
// constraint: Claude Code lists each running subagent under its prompt as a "◯ <type> <description>" row
export const subagentRowsOn = (screen: string) => screen.split("\n").filter((l) => /^\s*◯ \S+ \S/.test(l)).map((l) => l.trim());

// constraint: Bun's file.slice(-n) on a file shorter than n does not return the whole file, so the start is explicit
export async function transcriptTail(path: string) {
  const file = Bun.file(path);
  try {
    return await file.slice(Math.max(0, file.size - TRANSCRIPT_TAIL_BYTES)).text();
  } catch {
    return "";
  }
}
