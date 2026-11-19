import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const BORDER = "─".repeat(20);
const fakeClaudeDir = mkdtempSync(join(tmpdir(), "maxflow-fake-claude-"));
writeFileSync(join(fakeClaudeDir, "claude"), `#!/bin/sh\nstty -echo\nwhile true; do clear; printf '${BORDER}\\n❯ \\n${BORDER}\\n'; read -r _; done\n`);
chmodSync(join(fakeClaudeDir, "claude"), 0o755);

const instance = throwawayInstance("maxflow-pending-wait-");
const server = startServerWithoutSentries(instance, { PATH: `${fakeClaudeDir}:${process.env["PATH"] ?? ""}` });

afterAll(async () => {
  await stopByPidAndSocket(instance, server);
  rmSync(fakeClaudeDir, { recursive: true, force: true });
});

const PAST_DELIVERY_GRACE_MS = 31_000;
const theBrowsersMarker = { "sec-fetch-site": "same-origin" };

async function send(path: string, body: object, headers: Record<string, string> = {}) {
  return await fetch(`${instance.base}${path}`, withTimeout({ method: "POST", headers, body: JSON.stringify(body) }));
}

async function pendingIn(id: string) {
  type WorldThread = { id: string; pending?: { stale: boolean; status?: string; waitingOn?: string } };
  const world = (await (await fetch(`${instance.base}/api/world`, withTimeout())).json()) as { threads: WorldThread[] };
  return world.threads.find((t) => t.id === id)?.pending;
}

describe("th-ebe33f: a router asleep on CI for #51 showed only 'Stopped without answering' under his message", () => {
  test("a router that sleeps on ci:<pr> must say why, and the thread shows its wait instead of going stale", async () => {
    await waitUntilAnswering(instance, server);
    const router = (await (await send("/api/sessions", { name: "router", cmd: ["claude"], role: "router", objective: "obj-wait" })).json()) as { id: string };
    expect((await send(`/api/sessions/${router.id}/state`, { state: "idle" })).status).toBe(200);
    const { id } = (await (await send("/api/threads", { title: "ship #51", objective: "obj-wait" })).json()) as { id: string };
    expect((await send(`/api/threads/${id}/messages`, { text: "ship it" }, theBrowsersMarker)).status).toBe(201);

    const silent = await send(`/api/sessions/${router.id}/await`, { kind: "ci", ref: "isaac/maxflow#51" });
    expect(silent.status).toBe(409);
    expect(await silent.text()).toContain("--why");
    const why = "one unrelated browser test timed out; rerunning it, then merge and deploy";
    expect((await send(`/api/sessions/${router.id}/await`, { kind: "ci", ref: "isaac/maxflow#51", why })).status).toBe(200);

    await Bun.sleep(PAST_DELIVERY_GRACE_MS);
    expect(await pendingIn(id)).toMatchObject({ stale: false, status: why, waitingOn: router.id });
  }, 60_000);
});
