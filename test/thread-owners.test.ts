import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const BORDER = "─".repeat(20);
const fakeClaudeDir = mkdtempSync(join(tmpdir(), "yarn-fake-claude-"));
writeFileSync(join(fakeClaudeDir, "claude"), `#!/bin/sh\nstty -echo\nwhile true; do clear; printf '${BORDER}\\n❯ \\n${BORDER}\\n'; read -r _; done\n`);
chmodSync(join(fakeClaudeDir, "claude"), 0o755);
const emptyCwd = mkdtempSync(join(tmpdir(), "yarn-owner-cwd-"));

const instance = throwawayInstance("yarn-thread-owners-");
const server = startServerWithoutSentries(instance, { PATH: `${fakeClaudeDir}:${process.env["PATH"] ?? ""}` });

afterAll(async () => {
  await stopByPidAndSocket(instance, server);
  rmSync(fakeClaudeDir, { recursive: true, force: true });
  rmSync(emptyCwd, { recursive: true, force: true });
});

type Agent = { id: string; role?: { role: string; parent?: string; thread?: string }; wait?: { kind: string } | null };

const hisBrowser = { "sec-fetch-site": "same-origin" };

async function send(path: string, body: object, from?: string) {
  return await fetch(`${instance.base}${path}`, withTimeout({ method: "POST", headers: from === undefined ? hisBrowser : { "x-yarn-from": from }, body: JSON.stringify(body) }));
}
const json = async <T>(res: Response) => (await res.json()) as T;
async function agent(id: string) {
  const all = await json<Agent[]>(await fetch(`${instance.base}/api/sessions`, withTimeout()));
  return all.find((s) => s.id === id);
}
const signal = async (text: string) => (await json<{ seq: number }>(await send("/api/signals", { text }))).seq;

describe("thread owners (docs: yarn/thread-owners.md)", () => {
  test("with the switch on, a new signal gets an owner, routers are refused, and a follow-up reaches the same owner", async () => {
    await waitUntilAnswering(instance, server);
    const before = await fetch(`${instance.base}/api/thread-owners`, withTimeout());
    expect(await json<{ on: boolean }>(before)).toMatchObject({ on: false });
    expect(await json<{ on: boolean }>(await send("/api/thread-owners", { on: true }))).toMatchObject({ on: true });

    const first = await signal("ping");
    expect((await send(`/api/signals/${first}/size`, { size: "direct" })).status).toBe(409);
    expect((await send(`/api/signals/${first}/route`, { title: "an objective", cwd: emptyCwd })).status).toBe(409);
    expect((await send("/api/objectives", { title: "an objective", cwd: emptyCwd })).status).toBe(409);

    const sized = await json<{ session: string; thread: string; size: string }>(await send(`/api/signals/${first}/size`, { size: "owner", cwd: emptyCwd, name: "ping" }));
    expect(sized.size).toBe("owner");
    expect(await agent(sized.session)).toMatchObject({ role: { role: "owner", thread: sized.thread } });

    const worker = await json<Agent>(await send("/api/sessions", { name: "helper", cmd: ["claude"], cwd: emptyCwd }, sized.session));
    expect(worker.role).toMatchObject({ role: "worker", parent: sized.session });
    expect((await send("/api/asks", { text: "may I?" }, worker.id)).status).toBe(403);

    expect((await send(`/api/sessions/${sized.session}/await`, { kind: "agent", ref: worker.id, why: "the helper" })).status).toBe(200);
    expect((await send(`/api/sessions/${worker.id}/await`, { kind: "ci", ref: "some-branch" })).status).toBe(200);
    expect((await agent(sized.session))?.wait?.kind).toBe("agent");

    const second = await signal("pong");
    const routed = await json<{ thread: string; routedTo: string[] }>(await send(`/api/signals/${second}/route`, { thread: sized.thread }));
    expect(routed).toEqual({ thread: sized.thread, routedTo: [sized.session] });
  }, 30_000);
});
