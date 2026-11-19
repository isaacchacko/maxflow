import { accessibilityTree, click, evalIn, goTo, pageText, screenshot, typeInto } from "./browser-verbs";
import { BrowserCap, browserFor, CONSOLE_KEPT, closeBrowser, hasBrowser, isHeld, pageSocketUrl, type Browser } from "./browsers";
import { CdpError } from "./cdp";
import { sessions } from "./sessions";
import { isRecord, stringOr } from "./shared/guards";
import { unlessItFails } from "./cdp";

type Body = Record<string, unknown>;
type Act = (browser: Browser, body: Body) => Promise<Response> | Response;

const NONE_OPEN = "no browser open: start one with `browser open <url>`. A browser closes after 10 minutes unused, or when others need room under the cap of live browsers.";

const HELD = "Isaac has taken over this browser from the agent page. Wait for him to hand it back, then run this again.";

const CONSOLE_LAST = 100;

function collapsed(lines: string[]): string[] {
  const runs: { line: string; count: number }[] = [];
  for (const line of lines) {
    const run = runs.at(-1);
    if (run?.line === line) run.count += 1;
    else runs.push({ line, count: 1 });
  }
  return runs.map(({ line, count }) => (count > 1 ? `${line}  (×${String(count)})` : line));
}

function consoleReport(browser: Browser, asked: number): string {
  const last = Number.isSafeInteger(asked) && asked > 0 ? asked : CONSOLE_LAST;
  const lines = collapsed(browser.console);
  const shown = lines.slice(-last);
  const notes: string[] = [];
  if (browser.consoleDropped > 0) notes.push(`(${String(browser.consoleDropped)} older lines were dropped: only the last ${String(CONSOLE_KEPT)} are kept)`);
  if (shown.length < lines.length) notes.push(`(showing the last ${String(shown.length)} of ${String(lines.length)} lines: --last N for more)`);
  if (lines.length === 0) return "the console is empty";
  return [...notes, ...shown].join("\n");
}

const text = (body: string) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });

const ACTS: Record<string, Act> = {
  open: async (browser, body) => Response.json(await goTo(browser, stringOr(body["url"], "about:blank"))),
  screenshot: async (browser) => new Response(await screenshot(browser), { headers: { "content-type": "image/png" } }),
  read: async (browser, body) => text(body["ax"] === true ? await accessibilityTree(browser) : await pageText(browser)),
  click: async (browser, body) => text(await click(browser, stringOr(body["target"]))),
  type: async (browser, body) => text(await typeInto(browser, stringOr(body["target"]), stringOr(body["text"]), body["enter"] === true)),
  eval: async (browser, body) => Response.json(await evalIn(browser, stringOr(body["code"]))),
  console: (browser, body) => text(consoleReport(browser, Number(body["last"] ?? CONSOLE_LAST))),
  cdp: async (browser) => text(await pageSocketUrl(browser.port)),
};

function refusal(error: unknown): Response {
  if (error instanceof BrowserCap) return new Response(error.message, { status: 429 });
  if (error instanceof CdpError) return new Response(error.message, { status: 400 });
  throw error;
}

async function act(session: string, verb: string, req: Request): Promise<Response> {
  if (verb === "close") {
    await closeBrowser(session);
    return new Response(null, { status: 204 });
  }
  const run = Object.hasOwn(ACTS, verb) ? ACTS[verb] : undefined;
  if (!run) return new Response(`no browser verb ${verb}: ${[...Object.keys(ACTS), "close"].join(", ")}`, { status: 404 });
  if (verb !== "open" && !hasBrowser(session)) return new Response(NONE_OPEN, { status: 409 });
  if (isHeld(session)) return new Response(HELD, { status: 409 });
  const body: unknown = await unlessItFails(req.json());
  try {
    return await run(await browserFor(session), isRecord(body) ? body : {});
  } catch (error) {
    return refusal(error);
  }
}

export async function browserRoute(req: Request, path: string): Promise<Response | undefined> {
  const asked = /^\/api\/browsers\/([\w-]+)\/(\w+)$/.exec(path);
  if (!asked || req.method !== "POST") return undefined;
  const [, session = "", verb = ""] = asked;
  const from = req.headers.get("x-maxflow-from");
  if (from !== null && from !== session) return new Response("an agent drives only its own browser", { status: 403 });
  if (sessions.get(session)?.exitCode !== null) return new Response("no such live session", { status: 404 });
  return act(session, verb, req);
}
