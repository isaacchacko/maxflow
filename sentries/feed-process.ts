import { BASE as base } from "../instance";
import { readStateText, writeStateJson } from "../state";

const SERVER_CHECK_MS = 5000;
const SERVER_RETRY_MS = 2000;
const pidFile = (name: string) => `${name}-feed.pid`;

const didStop = (pid: number) => {
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
};

export function replaceOlderFeed(name: string) {
  const old = readStateText(pidFile(name))?.trim() ?? "";
  const isOlderFeed = old !== "" && Bun.spawnSync(["ps", "-p", old, "-o", "command="]).stdout.toString().includes(`sentries/${name}.ts`);
  if (isOlderFeed) didStop(Number(old));
  writeStateJson(pidFile(name), process.pid);
}

export const isStillTheFeed = (name: string) => process.ppid !== 1 && readStateText(pidFile(name)) === String(process.pid);

const isServerUp = async () => {
  try {
    return (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(SERVER_CHECK_MS) })).ok;
  } catch {
    return false;
  }
};

export async function waitForServer() {
  while (!(await isServerUp())) await Bun.sleep(SERVER_RETRY_MS);
}
