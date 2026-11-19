const RECENT_SHELL_MS = 12 * 3_600_000;
const TRANSCRIPT_TAIL_BYTES = 2_000_000;

const capturedIds = (line: string, pattern: RegExp) => line.matchAll(pattern).map((match) => match[1] ?? "");

const isRecentShellStart = (line: string) =>
  line.includes('"backgroundTaskId"') && Date.now() - Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? "") < RECENT_SHELL_MS;

export function backgroundShells(tail: string) {
  const running = new Set<string>();
  for (const line of tail.split("\n")) {
    if (isRecentShellStart(line)) for (const id of capturedIds(line, /"backgroundTaskId":"(\w+)"/g)) running.add(id);
    for (const id of capturedIds(line, /<task-id>(\w+)<\/task-id>/g)) running.delete(id);
  }
  return running;
}

// constraint: Bun's file.slice(-n) on a file shorter than n does not return the whole file, so the start is explicit
export async function transcriptTail(path: string) {
  const file = Bun.file(path);
  try {
    return await file.slice(Math.max(0, file.size - TRANSCRIPT_TAIL_BYTES)).text();
  } catch {
    return "";
  }
}
