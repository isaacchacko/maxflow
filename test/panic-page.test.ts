import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// constraint: happy-dom registered for the whole run would replace fetch and friends for the other test files
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:4949/", settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } }));
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
const urlOf = (input: string | URL | Request) => (input instanceof Request ? input.url : String(input));

function answer(path: string): Response {
  if (!server.isBack) return path === "/__panic/state" ? Response.json(DEPLOYING, { headers: { "x-yarn-panic": "1" } }) : new Response("maxflow is down", { status: 503, headers: { "x-yarn-panic": "1" } });
  if (path === "/api/instance") return Response.json({ instance: "live", port: 4949, pid: 1 });
  if (path === "/__panic/state") return new Response("not found", { status: 404 });
  return new Response("<html></html>", { headers: { "content-type": "text/html" } });
}
const NETWORK_MS = 1;
const fakeFetch = async (input: string | URL | Request) => {
  await Bun.sleep(NETWORK_MS);
  return answer(new URL(urlOf(input), "http://localhost:4949/").pathname);
};

const text = (id: string) => document.querySelector(`#${id}`)?.textContent ?? "";

async function hasHappened(isDone: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (isDone()) return true;
    await Bun.sleep(100);
  }
  return isDone();
}

test("the panic page keeps rendering through a deploy and comes back once the server answers", async () => {
  const page = document.defaultView;
  Reflect.set(globalThis, "fetch", fakeFetch);
  if (page !== null) Reflect.set(page, "fetch", fakeFetch);
  document.body.innerHTML = BODY;
  const script = document.createElement("script");
  script.textContent = SCRIPT;
  document.body.append(script);

  expect(await hasHappened(() => text("line").startsWith("Deploying f549995"), 3000)).toBe(true);
  const firstLine = text("line");
  expect(await hasHappened(() => text("line") !== firstLine, 3000)).toBe(true);
  expect(document.querySelector("#runs")).not.toBeNull();
  expect(text("runs")).toContain("1 restart");

  server.isBack = true;
  expect(await hasHappened(() => text("line") === "Back! Reloading…", 4000)).toBe(true);
}, 15_000);
