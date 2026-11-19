import { afterAll, describe, expect, test } from "bun:test";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const instance = throwawayInstance("maxflow-author-");
const server = startServerWithoutSentries(instance);

afterAll(async () => {
  await stopByPidAndSocket(instance, server);
});

const theBrowsersMarker = { "sec-fetch-site": "same-origin" };

async function send(path: string, body: object, headers: Record<string, string> = {}) {
  return await fetch(`${instance.base}${path}`, withTimeout({ method: "POST", headers, body: JSON.stringify(body) }));
}

async function saidIn(id: string) {
  const res = await fetch(`${instance.base}/api/threads`, withTimeout());
  const threads = (await res.json()) as { id: string; messages: { from: string; text: string }[] }[];
  return threads.find((t) => t.id === id)?.messages.map((m) => [m.from, m.text]);
}

describe("m-140a9e: a `thread post` run over ssh with no MAXFLOW_SESSION showed an agent's words under Isaac's name", () => {
  test("only the browser posts as Isaac; an outside agent posts under its --as label, and anything else is refused", async () => {
    await waitUntilAnswering(instance, server);
    const inboxThreadWithoutSession = await send("/api/threads", { text: "agent words" });
    expect(inboxThreadWithoutSession.status).toBe(403);
    expect((await send("/api/threads", { text: "agent words", as: "cleopatra/yarn-browser" })).status).toBe(400);

    const opened = await send("/api/threads", { title: "author test", objective: "none" });
    expect(opened.status).toBe(201);
    const { id } = (await opened.json()) as { id: string };
    const posts = `/api/threads/${id}/messages`;

    const refused = await send(posts, { text: "agent words" });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("--as <device>/<name>");
    expect((await send(posts, { text: "agent words" }, { "x-maxflow-from": "deadbeef" })).status).toBe(403);
    expect((await send(posts, { text: "agent words" }, { "x-maxflow-from": "deadbeef", ...theBrowsersMarker })).status).toBe(403);
    expect((await send(posts, { text: "agent words", as: "isaac" })).status).toBe(403);
    expect((await send(posts, { text: "agent words", as: "isaac" }, theBrowsersMarker)).status).toBe(403);
    expect((await send(posts, { text: "outside words", as: "cleopatra/yarn-browser" })).status).toBe(201);
    expect((await send(posts, { text: "his words" }, theBrowsersMarker)).status).toBe(201);

    const sub = await send("/api/threads", { parent: { thread: id, message: "nonexistent" }, text: "agent words" });
    expect(sub.status).toBe(403);

    expect(await saidIn(id)).toEqual([
      ["cleopatra/yarn-browser", "outside words"],
      ["isaac", "his words"],
    ]);
  }, 45_000);
});
