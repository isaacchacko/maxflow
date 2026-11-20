import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundSubagents } from "../background";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const BORDER = "─".repeat(20);
const fakeClaudeDir = mkdtempSync(join(tmpdir(), "yarn-fake-claude-"));
writeFileSync(join(fakeClaudeDir, "claude"), `#!/bin/sh\nstty -echo\nwhile true; do clear; printf '${BORDER}\\n❯ \\n${BORDER}\\n'; read -r _; done\n`);
chmodSync(join(fakeClaudeDir, "claude"), 0o755);

const instance = throwawayInstance("yarn-no-silent-sleep-");
const server = startServerWithoutSentries(instance, { PATH: `${fakeClaudeDir}:${process.env["PATH"] ?? ""}` });

afterAll(async () => {
  await stopByPidAndSocket(instance, server);
  rmSync(fakeClaudeDir, { recursive: true, force: true });
});

const theBrowsersMarker = { "sec-fetch-site": "same-origin" };
const SETTLE_MS = 4000;

const launched = (agentId: string) =>
  `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] }, toolUseResult: { isAsync: true, status: "async_launched", agentId, description: "Catalog bundle failures" } })}\n`;
const finished = (agentId: string) =>
  `${JSON.stringify({ type: "queue-operation", timestamp: new Date().toISOString(), content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n</task-notification>` })}\n`;

async function send(path: string, body: object, headers: Record<string, string> = {}, method = "POST") {
  return await fetch(`${instance.base}${path}`, withTimeout({ method, headers, body: JSON.stringify(body) }));
}
async function world() {
  type Row = { id: string; state: string; sleep?: { at: string; wakes: string }; sleepHeld?: { what: string[] } };
  type WorldThread = { id: string; asleep: { sessionId: string; name: string; wakes: string }[]; messages: { from: string; text: string }[] };
  return (await (await fetch(`${instance.base}/api/world`, withTimeout())).json()) as { agents: Row[]; threads: WorldThread[] };
}
const isClaudeStopped = async (id: string) => ((await (await fetch(`${instance.base}/api/sessions/${id}/screen`, withTimeout())).json()) as { asleep: boolean }).asleep;
const rowOf = async (id: string) => (await world()).agents.find((a) => a.id === id);
const threadOf = async (id: string) => (await world()).threads.find((t) => t.id === id);

async function untilPromptDrawn(id: string) {
  for (let tries = 0; tries < 40; tries++) {
    const { screen } = (await (await fetch(`${instance.base}/api/sessions/${id}/screen`, withTimeout())).json()) as { screen: string };
    if (screen.includes("❯")) return;
    await Bun.sleep(250);
  }
}
async function agent(name: string, role: object = {}) {
  const { id } = (await (await send("/api/sessions", { name, cmd: ["claude"], ...role })).json()) as { id: string };
  await untilPromptDrawn(id);
  expect((await send(`/api/sessions/${id}/state`, { state: "idle" })).status).toBe(200);
  return id;
}
async function giveTranscript(id: string) {
  const transcript = join(instance.home, `${crypto.randomUUID()}.jsonl`);
  writeFileSync(transcript, "");
  expect((await send(`/api/sessions/${id}/state`, { state: "idle", transcript })).status).toBe(200);
  return transcript;
}
async function agentWithTranscript(name: string, role: object = {}) {
  const id = await agent(name, role);
  return { id, transcript: await giveTranscript(id) };
}
async function routerHandedHisMessage(objective: string, title: string) {
  const id = await agent("router", { role: "router", objective });
  const { id: thread } = (await (await send("/api/threads", { title, objective })).json()) as { id: string };
  expect((await send(`/api/threads/${thread}/messages`, { text: "go" }, theBrowsersMarker)).status).toBe(201);
  for (let tries = 0; tries < 20 && (await (await fetch(`${instance.base}/api/sessions/${id}/screen`, withTimeout())).json() as { pending: number }).pending > 0; tries++) await Bun.sleep(500);
  await giveTranscript(id);
  return { id, thread };
}

describe("th-7d528b: a lint coordinator asleep on its subagents was killed with them", () => {
  test("a subagent's launch counts as running until its task-notification lands", () => {
    expect(backgroundSubagents(launched("a63869df8fe4aab0a"))).toEqual(new Set(["a63869df8fe4aab0a"]));
    expect(backgroundSubagents(launched("a63869df8fe4aab0a") + finished("a63869df8fe4aab0a")).size).toBe(0);
  });

  test("an agent with a subagent still running and a declared wait is not put to sleep, and sleeps once it finishes", async () => {
    await waitUntilAnswering(instance, server);
    const { id, transcript } = await agentWithTranscript("coordinator");
    appendFileSync(transcript, launched("a1061da1a2f9127af"));

    expect((await send(`/api/sessions/${id}/await`, { kind: "ci", ref: "isaac/yarn#51" })).status).toBe(200);
    await Bun.sleep(SETTLE_MS);
    expect(await isClaudeStopped(id)).toBe(false);
    expect((await rowOf(id))?.sleepHeld?.what).toEqual(["1 subagent"]);

    appendFileSync(transcript, finished("a1061da1a2f9127af"));
    expect((await send(`/api/sessions/${id}/state`, { state: "idle" })).status).toBe(200);
    await Bun.sleep(SETTLE_MS);
    expect(await isClaudeStopped(id)).toBe(true);
    expect((await rowOf(id))?.state).toBe("asleep");
  }, 30_000);
});

describe("th-9942f7: an agent put to sleep says so where he looks", () => {
  test("its thread shows it asleep and what wakes it, and the world shows it asleep", async () => {
    await waitUntilAnswering(instance, server);
    const { id, thread } = await routerHandedHisMessage("obj-sleep", "ship #52");
    expect((await send(`/api/sessions/${id}/await`, { kind: "ci", ref: "isaac/yarn#52", why: "CI on #52, then deploy" })).status).toBe(200);
    await Bun.sleep(SETTLE_MS);

    const row = await rowOf(id);
    expect(row?.state).toBe("asleep");
    expect(row?.sleep?.wakes).toBe("CI finishes on isaac/yarn#52");
    const t = await threadOf(thread);
    expect(t?.asleep.map((a) => [a.sessionId, a.name, a.wakes])).toEqual([[id, "router", "CI finishes on isaac/yarn#52"]]);
    expect(t?.messages.some((m) => m.from === "yarn")).toBe(false);
  }, 30_000);

  test("an agent put to sleep with his message unanswered posts loudly in the thread", async () => {
    const { id, thread } = await routerHandedHisMessage("obj-loud", "fix the build");
    expect((await send(`/api/sessions/${id}`, { archived: true }, { ...theBrowsersMarker, "user-agent": "Mozilla/5.0" }, "PATCH")).status).toBeLessThan(300);
    await Bun.sleep(SETTLE_MS);

    expect((await rowOf(id))?.state).toBe("asleep");
    const loud = (await threadOf(thread))?.messages.find((m) => m.from === "yarn");
    expect(loud?.text).toContain("was put to sleep with work still open");
    expect(loud?.text).toContain("has no answer");
  }, 30_000);
});
