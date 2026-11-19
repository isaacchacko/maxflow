import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../instance";

function recordedPid(file: string) {
  const pid = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0;
  return Number.isNaN(pid) ? 0 : pid;
}

export function takeOver(name: string) {
  const file = join(STATE_DIR, `${name}.pid`);
  const olderCopy = recordedPid(file);
  const command = olderCopy !== 0 && olderCopy !== process.pid ? Bun.spawnSync(["ps", "-o", "command=", "-p", String(olderCopy)]).stdout.toString() : "";
  if (command.includes(`sentries/${name}.ts`)) {
    process.kill(olderCopy, "SIGTERM");
    console.log(`stopped an older ${name} sentry (pid ${olderCopy}) still running beside this one`);
  }
  writeFileSync(file, String(process.pid));
}
