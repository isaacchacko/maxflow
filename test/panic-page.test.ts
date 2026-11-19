import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// constraint: happy-dom registered for the whole run would replace fetch and friends for the other test files
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:4949/" }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const PAGE = readFileSync(join(import.meta.dir, "../sentries/panic.html"), "utf8");
const BODY = /<body>([\s\S]*?)<script src=/.exec(PAGE)?.[1] ?? "";
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1] ?? "";
const DEPLOYING = {
  down: true,
  downSince: Date.now() - 5000,
  deploy: { commit: "f549995", at: Date.now() - 5000, expectedMs: 60_000 },
  helperDueAt: Date.now() + 65_000,
  agent: null,
  gaveUp: null,
  launchd: { attempts: 1, lastExit: "0" },
  log: "",
};
const server = { isBack: false };
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost:4949/").pathname;
  if (!server.isBack) return Promise.resolve(path === "/__panic/state" ? json(DEPLOYING, { "x-yarn-panic": "1" }) : new Response("maxflow is down", { status: 503, headers: { "x-yarn-panic": "1" } }));
  if (path === "/api/instance") return Promise.resolve(json({ instance: "live", port: 4949, pid: 1 }));
  if (path === "/__panic/state") return Promise.resolve(new Response("not found", { status: 404 }));
  return Promise.resolve(new Response("<html></html>", { headers: { "content-type": "text/html" } }));
}

const text = (id: string) => document.getElementById(id)?.textContent ?? "";

async function until(isDone: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (isDone()) return true;
    await Bun.sleep(100);
  }
  return isDone();
}

test("the panic page keeps rendering through a deploy and comes back once the server answers", async () => {
  Reflect.set(globalThis, "fetch", fakeFetch);
  const errors: unknown[] = [];
  window.addEventListener("error", (event) => errors.push(event.error));
  document.body.innerHTML = BODY;
  new Function(SCRIPT)();

  expect(await until(() => text("line").startsWith("Deploying f549995"), 3000)).toBe(true);
  const firstLine = text("line");
  expect(await until(() => text("line") !== firstLine, 3000)).toBe(true);
  expect(document.getElementById("runs")).not.toBeNull();
  expect(text("runs")).toContain("1 restart");

  server.isBack = true;
  expect(await until(() => text("line") === "Back! Reloading…", 4000)).toBe(true);
  expect(errors).toEqual([]);
}, 15_000);
