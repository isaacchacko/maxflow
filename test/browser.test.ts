import { afterAll, expect, test } from "bun:test";
import { chromeBinary } from "../chrome";
import { startServerWithoutSentries, stopByPidAndSocket, throwawayInstance, waitUntilAnswering, withTimeout } from "./throwaway-instance";

const PAGE = `<!doctype html><title>Form</title><h1>Hello</h1>
<form onsubmit="event.preventDefault(); out.textContent = 'sent ' + email.value; console.log('sent', email.value)">
<input id="email" placeholder="Email"><button>Send it</button></form><p id="out"></p><a href="#two">Second link</a>`;

const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
const instance = throwawayInstance("maxflow-browser-");
const server = startServerWithoutSentries(instance);
const sessionIds: string[] = [];

afterAll(async () => {
  for (const id of sessionIds) await fetch(`${instance.base}/api/browsers/${id}/close`, withTimeout({ method: "POST" }));
  await site.stop();
  await stopByPidAndSocket(instance, server);
});

async function newSession() {
  await waitUntilAnswering(instance, server);
  const res = await fetch(`${instance.base}/api/sessions`, withTimeout({ method: "POST", body: JSON.stringify({ name: "browser-test", cmd: ["sh", "-c", "sleep 120"], cwd: instance.home }) }));
  const { id } = (await res.json()) as { id: string };
  sessionIds.push(id);
  return id;
}

const browse = async (id: string, verb: string, body: unknown = {}, from = id) =>
  fetch(`${instance.base}/api/browsers/${id}/${verb}`, { method: "POST", headers: { "x-maxflow-from": from }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });

test.skipIf(chromeBinary() === undefined)(
  "an agent opens a page, types into it, clicks, and reads it back",
  async () => {
    const id = await newSession();
    expect((await browse(id, "read")).status).toBe(409);
    expect(await (await browse(id, "open", { url: `127.0.0.1:${String(site.port)}` })).json()).toEqual({ url: `http://127.0.0.1:${String(site.port)}/`, title: "Form" });
    expect(await (await browse(id, "read", { ax: true })).text()).toContain('textbox "Email"');
    expect(await (await browse(id, "type", { target: "#email", text: "ada@example.com", enter: true })).text()).toBe("typed into input, then Enter");
    expect(await (await browse(id, "eval", { code: "out.textContent" })).json()).toEqual({ value: "sent ada@example.com" });
    await browse(id, "type", { target: "Email", text: "bob@example.com" });
    expect(await (await browse(id, "eval", { code: "email.value" })).json()).toEqual({ value: "bob@example.com" });
    expect(await (await browse(id, "click", { target: "Second link" })).text()).toBe('clicked a "Second link"');
    expect(await (await browse(id, "eval", { code: "location.hash" })).json()).toEqual({ value: "#two" });
    expect(await (await browse(id, "console")).text()).toContain("log: sent ada@example.com");
    expect((await browse(id, "screenshot")).headers.get("content-type")).toBe("image/png");
  },
  60_000,
);

test.skipIf(chromeBinary() === undefined)(
  "an agent can't drive another's browser, or open a file",
  async () => {
    const id = await newSession();
    expect((await browse(id, "open", { url: "about:blank" }, "someone-else")).status).toBe(403);
    expect(await (await browse(id, "open", { url: "file:///etc/passwd" })).text()).toContain("only http(s)");
  },
  60_000,
);

async function untilTrue(isDone: () => boolean) {
  while (!isDone()) await Bun.sleep(50);
}

async function viewerOf(id: string) {
  const socket = new WebSocket(`ws://localhost:${String(instance.port)}/ws/browser/${id}`);
  socket.binaryType = "arraybuffer";
  const said = new Map<string, unknown>();
  const seen: { frame?: ArrayBuffer } = {};
  socket.addEventListener("message", (e: MessageEvent<unknown>) => {
    if (e.data instanceof ArrayBuffer) seen.frame = e.data;
    if (typeof e.data !== "string") return;
    const message = JSON.parse(e.data) as { type: string };
    said.set(message.type, message);
  });
  await untilTrue(() => socket.readyState === WebSocket.OPEN);
  return { socket, said, seen };
}

test.skipIf(chromeBinary() === undefined)(
  "a viewer of the agent's page gets where its browser is and a live frame",
  async () => {
    const id = await newSession();
    await browse(id, "open", { url: `127.0.0.1:${String(site.port)}` });
    const viewer = await viewerOf(id);
    await untilTrue(() => viewer.said.has("page") && viewer.seen.frame !== undefined);
    expect(viewer.said.get("page")).toEqual({ type: "page", url: `http://127.0.0.1:${String(site.port)}/`, title: "Form" });
    expect([...new Uint8Array(viewer.seen.frame ?? new ArrayBuffer(0)).subarray(0, 2)]).toEqual([0xFF, 0xD8]);
    viewer.socket.close();
  },
  60_000,
);

const isHeldBy = (viewer: Awaited<ReturnType<typeof viewerOf>>) => (viewer.said.get("held") as { isHeld?: boolean } | undefined)?.isHeld;

test.skipIf(chromeBinary() === undefined)(
  "while Isaac has taken over, his keys reach the page and the agent's verbs are refused",
  async () => {
    const id = await newSession();
    await browse(id, "open", { url: `127.0.0.1:${String(site.port)}` });
    await browse(id, "click", { target: "#email" });
    const viewer = await viewerOf(id);
    viewer.socket.send(JSON.stringify({ type: "hold", isTaking: true }));
    await untilTrue(() => isHeldBy(viewer) === true);
    expect((await browse(id, "read")).status).toBe(409);
    viewer.socket.send(JSON.stringify({ type: "text", text: "isaac" }));
    viewer.socket.send(JSON.stringify({ type: "key", kind: "keyDown", key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 }));
    viewer.socket.send(JSON.stringify({ type: "hold", isTaking: false }));
    await untilTrue(() => isHeldBy(viewer) === false);
    expect(await (await browse(id, "eval", { code: "out.textContent" })).json()).toEqual({ value: "sent isaac" });
    viewer.socket.close();
  },
  60_000,
);
