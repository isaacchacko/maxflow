import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const instance = throwawayInstance("yarn-unsent-");
const bin = join(instance.home, "bin");
const enterReachedClaude = join(instance.home, "submitted");

function installFakeClaudeShowingAPasteThatRecordsEnter() {
  mkdirSync(bin);
  const rule = "─".repeat(40);
  const prompt = "❯";
  writeFileSync(
    join(bin, "claude"),
    String.raw`#!/bin/sh
stty raw -echo
printf '${rule}\r\n${prompt} [Pasted text #1 +2 lines]\r\n${rule}\r\n'
while :; do
  c=$(dd bs=1 count=1 2>/dev/null | od -An -c | tr -d ' ')
  [ "$c" = '\r' ] && { touch '${enterReachedClaude}'; printf '\033[2J\033[H${rule}\r\n${prompt} \r\n${rule}\r\n'; }
done
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
}

installFakeClaudeShowingAPasteThatRecordsEnter();
const server = startServerWithoutSentries(instance, { PATH: `${bin}:${process.env["PATH"] ?? ""}` });

afterAll(async () => {
  await stopByPidAndSocket(instance, server);
});

describe("a restart between pasting an inbox message and its Enter leaves the paste in claude's prompt with no record of it", () => {
  test("a message left pasted in the prompt unsent gets its Enter", async () => {
    await waitUntilAnswering(instance, server);
    const res = await fetch(`${instance.base}/api/sessions`, withTimeout({ method: "POST", body: JSON.stringify({ name: "unsent-test", cmd: ["claude"], cwd: instance.home }) }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const notified = await fetch(`${instance.base}/api/sessions/${id}/notify`, withTimeout({ method: "POST", body: JSON.stringify({ text: "[yarn] one\ntwo\nthree" }) }));
    expect(notified.status).toBe(202);
    for (const end = Date.now() + 20_000; !existsSync(enterReachedClaude) && Date.now() < end; ) await Bun.sleep(250);
    expect(existsSync(enterReachedClaude)).toBe(true);
    const db = new Database(join(instance.home, `.maxflow-v2-${instance.name}`, "yarn.db"), { readonly: true });
    const storedInboxARestartWouldRead = () => db.query("SELECT data FROM inboxes WHERE key = ?").get(id);
    for (const end = Date.now() + 10_000; storedInboxARestartWouldRead() !== null && Date.now() < end; ) await Bun.sleep(250);
    expect(storedInboxARestartWouldRead()).toBeNull();
    db.close();
  }, 45_000);
});
