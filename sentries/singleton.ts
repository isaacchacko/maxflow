import { readStateText, writeStateText } from "../state";

function recordedPid(name: string) {
  const pid = Number((readStateText(`${name}.pid`) ?? "0").trim());
  return Number.isNaN(pid) ? 0 : pid;
}

export function takeOver(name: string) {
  const olderCopy = recordedPid(name);
  const command = olderCopy === 0 || olderCopy === process.pid ? "" : Bun.spawnSync(["ps", "-o", "command=", "-p", String(olderCopy)]).stdout.toString();
  if (command.includes(`sentries/${name}.ts`)) {
    process.kill(olderCopy, "SIGTERM");
    console.log(`stopped an older ${name} sentry (pid ${String(olderCopy)}) still running beside this one`);
  }
  writeStateText(`${name}.pid`, String(process.pid));
}
