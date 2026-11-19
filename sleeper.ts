import { existsSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";

const DIM = "\u{1B}[2m";
const RED = "\u{1B}[31m";
const RESET = "\u{1B}[0m";
const PASTE_SETTLE_MS = 50;
const WAKE_TIMEOUT_MS = 30_000;

const [lastScreenFile = "", base = "", id = ""] = process.argv.slice(2);

function showLastScreen() {
  if (!existsSync(lastScreenFile)) return;
  process.stdout.write(readFileSync(lastScreenFile));
  rmSync(lastScreenFile);
}

showLastScreen();
process.stdout.write(`${DIM}[maxflow] asleep: claude is stopped to free memory. Type to wake it.${RESET}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "❯ " });
rl.prompt();

const pasteInProgress: { lines: string[]; timer: Timer | undefined } = { lines: [], timer: undefined };

async function postWake(text: string) {
  try {
    return await fetch(`${base}/api/sessions/${id}/wake`, { method: "POST", body: JSON.stringify({ text }), signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

const failureReason = async (res: Response | null) => (res ? res.text() : "server unreachable");

async function sendPasteAsOneMessage() {
  const text = pasteInProgress.lines.join("\n").trim();
  pasteInProgress.lines = [];
  if (!text) {
    rl.prompt();
    return;
  }
  const res = await postWake(text);
  if (res?.ok === true) {
    process.stdout.write(`${DIM}waking…${RESET}\n`);
    return;
  }
  process.stdout.write(`${RED}couldn't wake it (${await failureReason(res)}); try again${RESET}\n`);
  rl.prompt();
}

rl.on("line", (line) => {
  pasteInProgress.lines.push(line);
  clearTimeout(pasteInProgress.timer);
  pasteInProgress.timer = setTimeout(() => {
    void sendPasteAsOneMessage();
  }, PASTE_SETTLE_MS);
});
