// One process per sentry. A sentry's script starting while an older copy of it still runs (a server restart that lost track of the
// first, then started a second) stops that older copy, so the copy the server knows about is the one left running.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../instance";

export function takeOver(name: string) {
  const file = join(STATE_DIR, `${name}.pid`);
  const old = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) || 0 : 0;
  const command = old && old !== process.pid ? Bun.spawnSync(["ps", "-o", "command=", "-p", String(old)]).stdout.toString() : "";
  if (command.includes(`sentries/${name}.ts`)) {
    process.kill(old, "SIGTERM");
    console.log(`stopped an older ${name} sentry (pid ${old}) still running beside this one`);
  }
  writeFileSync(file, String(process.pid));
}
