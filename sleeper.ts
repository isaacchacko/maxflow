// What an archived agent's pane runs while its claude is stopped: its last screen, then a prompt. What the user types there
// wakes the agent and reaches its claude as if typed into it.
import { createInterface } from "node:readline";
import { existsSync, readFileSync, rmSync } from "node:fs";

const [screen, base, id] = process.argv.slice(2);
if (existsSync(screen)) process.stdout.write(readFileSync(screen)), rmSync(screen);
process.stdout.write("\x1b[2m[maxflow] asleep: claude is stopped to free memory. Type to wake it.\x1b[0m\n");

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "❯ " });
rl.prompt();
// A paste arrives as several lines at once; they go as one message.
let lines: string[] = [];
let timer: Timer | undefined;
rl.on("line", (line) => {
  lines.push(line);
  clearTimeout(timer);
  timer = setTimeout(send, 50);
});
async function send() {
  const text = lines.join("\n").trim();
  lines = [];
  if (!text) return rl.prompt();
  const res = await fetch(`${base}/api/sessions/${id}/wake`, { method: "POST", body: JSON.stringify({ text }) }).catch(() => null);
  process.stdout.write(res?.ok ? "\x1b[2mwaking…\x1b[0m\n" : `\x1b[31mcouldn't wake it (${res ? await res.text() : "server unreachable"}); try again\x1b[0m\n`);
  if (!res?.ok) rl.prompt();
}
