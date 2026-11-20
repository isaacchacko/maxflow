import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const instance = throwawayInstance("maxflow-until-argv-");
const server = startServerWithoutSentries(instance);

afterAll(async () => {
  await stopByPidAndSocket(instance, server);
});

const shellsOf = (owner: string) => {
  type Shell = { owner: string; cmd?: string; end?: { code: number | null; tail: string } };
  const file = join(instance.home, `.maxflow-v2-${instance.name}`, "shells.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Shell[]).filter((x) => x.owner === owner) : [];
};

describe("0e988876: `wait until ... -- sh -c '<loop with do/done>'` died with 'parse error near do'", () => {
  test("each argument after -- reaches the shell as one word, spaces, quotes and shell keywords included", async () => {
    await waitUntilAnswering(instance, server);
    const created = await fetch(`${instance.base}/api/sessions`, withTimeout({ method: "POST", body: JSON.stringify({ name: "waiter", cmd: ["sleep", "600"] }) }));
    const { id } = (await created.json()) as { id: string };
    const loop = `for word in one "two words"; do echo "got $word"; done; echo "it's done"`;
    const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../cli.ts"), "wait", "until", "the loop prints", "--", "sh", "-c", loop], {
      env: { ...process.env, MAXFLOW_INSTANCE: instance.name, MAXFLOW_PORT: String(instance.port), MAXFLOW_SESSION: id },
      stderr: "pipe",
    });
    expect(cli.stderr.toString()).toBe("");

    for (const end = Date.now() + 15_000; Date.now() < end && shellsOf(id)[0]?.end === undefined; ) await Bun.sleep(200);
    const [shell] = shellsOf(id);
    expect(shell?.end?.code).toBe(0);
    expect(shell?.end?.tail).toContain("got one\ngot two words\nit's done");
  }, 45_000);
});
