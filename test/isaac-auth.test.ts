import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const instance = throwawayInstance("yarn-isaac-auth-");
const stateDir = join(instance.home, `.yarn-v2-${instance.name}`);
mkdirSync(stateDir, { recursive: true });
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const [fresh, stale] = ["fresh-token", "stale-token"];
writeFileSync(join(stateDir, "isaac-passkeys.json"), JSON.stringify([{ id: "test-passkey", publicKey: "AA", counter: 0, transports: [], at: Date.now(), label: "test" }]));
writeFileSync(join(stateDir, "isaac-sessions.json"), JSON.stringify([{ hash: hashOf(fresh), at: Date.now(), verifiedAt: Date.now() + 3_600_000 }, { hash: hashOf(stale), at: Date.now(), verifiedAt: 0 }]));
const server = startServerWithoutSentries(instance);

afterAll(async () => {
  await stopByPidAndSocket(instance, server);
});

const aBrowser = { "sec-fetch-site": "same-origin", "user-agent": "Mozilla/5.0 HeadlessChrome" };
const send = async (path: string, body: unknown, headers: Record<string, string>, method = "POST") => fetch(`${instance.base}${path}`, withTimeout({ method, headers, body: JSON.stringify(body) }));

async function made(name: string) {
  const res = await send("/api/sessions", { name, cmd: ["sh", "-c", "sleep 60"], cwd: instance.home }, {});
  return ((await res.json()) as { id: string }).id;
}

async function gated() {
  const session = await made("gated");
  const thread = (await (await send("/api/threads", { title: "a thread for the test", objective: "test" }, { "x-yarn-from": session })).json()) as { id: string };
  return [
    ["/api/merge-gate", { on: false }, "POST"],
    ["/api/prs/merge", { pr: "a/b#1" }, "POST"],
    ["/api/board/post", { channel: "yarn/test", text: "as isaac?" }, "POST"],
    [`/api/threads/${thread.id}/messages`, { text: "his words?" }, "POST"],
    ["/api/threads", { text: "a new request from him?" }, "POST"],
    [`/api/threads/${thread.id}`, { resolved: true }, "PATCH"],
    ["/api/pins", { order: [] }, "PATCH"],
    [`/api/sessions/${session}`, { archived: true }, "PATCH"],
  ] as const;
}

test("once he has a passkey, a browser without his token is refused everywhere he alone may act, and an agent is refused outright", async () => {
  await waitUntilAnswering(instance, server);
  const routes = await gated();
  for (const [path, body, method] of routes) {
    const asABrowser = await send(path, body, aBrowser, method);
    expect([path, asABrowser.status, asABrowser.headers.get("x-yarn-isaac")]).toEqual([path, 401, "sign-in"]);
    const asAnAgent = await send(path, body, { ...aBrowser, "x-yarn-from": "dd2cf747" }, method);
    expect([path, asAnAgent.status === 401 || asAnAgent.status === 403]).toEqual([path, true]);
    expect([path, asAnAgent.headers.get("x-yarn-isaac")]).toEqual([path, null]);
  }
});

test("his signed-in token posts as him, and the gate and merge also need Touch ID within the last minutes", async () => {
  const flipped = await send("/api/merge-gate", { on: true }, { ...aBrowser, "x-yarn-isaac-token": fresh });
  expect(flipped.status).toBe(200);
  const notFresh = await send("/api/merge-gate", { on: true }, { ...aBrowser, "x-yarn-isaac-token": stale });
  expect([notFresh.status, notFresh.headers.get("x-yarn-isaac")]).toEqual([401, "fresh"]);
  const status = (await (await fetch(`${instance.base}/api/isaac`, withTimeout({ headers: { "x-yarn-isaac-token": stale } }))).json()) as { signedIn: boolean; fresh: boolean };
  expect(status).toMatchObject({ signedIn: true, fresh: false });
});

test("no one enrolls a second passkey without him signed in", async () => {
  const res = await send("/api/isaac/enroll/options", {}, aBrowser);
  expect(res.status).toBe(403);
});

test("typing into an agent, waking it with words and the event-log chat all need his sign-in", async () => {
  const agent = (await (await send("/api/sessions", { name: "typed-into", cmd: ["claude"], cwd: instance.home }, {})).json()) as { id: string };
  for (const [path, body] of [
    [`/api/sessions/${agent.id}/input`, { text: "do the thing", enter: true }],
    [`/api/sessions/${agent.id}/wake`, { text: "do the thing" }],
    ["/api/signals", { text: "do the thing" }],
  ] as const) {
    const res = await send(path, body, aBrowser);
    expect([path, res.status]).toEqual([path, 401]);
  }
  const signedIn = await send(`/api/sessions/${agent.id}/input`, { keys: ["Escape"] }, { ...aBrowser, "x-yarn-isaac-token": fresh });
  expect(signedIn.status === 401 || signedIn.status === 403).toBe(false);
});

