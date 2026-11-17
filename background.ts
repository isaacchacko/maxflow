// Background shells a claude started (Bash with run_in_background) that haven't reported back, read from its transcript: the shell's
// exit re-invokes the agent, so an agent with one isn't idle. Only shells started in the last 12h count; older ones are taken as lost.
export function backgroundShells(tail: string) {
  const running = new Set<string>();
  for (const line of tail.split("\n")) {
    if (line.includes('"backgroundTaskId"') && Date.now() - Date.parse(line.match(/"timestamp":"([^"]+)"/)?.[1] ?? "") < 12 * 3_600_000)
      for (const m of line.matchAll(/"backgroundTaskId":"(\w+)"/g)) running.add(m[1]);
    for (const m of line.matchAll(/<task-id>(\w+)<\/task-id>/g)) running.delete(m[1]);
  }
  return running;
}

// The last 2MB of a transcript, read with an explicit start: Bun's slice(-n) on a file shorter than n does not return the whole file.
export async function transcriptTail(path: string) {
  const file = Bun.file(path);
  return file.slice(Math.max(0, file.size - 2_000_000)).text().catch(() => "");
}
