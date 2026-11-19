import { publish } from "./bus";
import { Cdp, CdpError, unlessItFails } from "./cdp";
import { chromeBinary } from "./chrome";
import { isRecord } from "./shared/guards";
import { listState, readStateText, removeState, removeStateDirectory, stateDirectory } from "./state";

export type Browser = { session: string; port: number; page: Cdp; usedAt: number; console: string[]; watchers: number; isHeld: boolean };

const MAX_BROWSERS = Number(process.env["MAXFLOW_BROWSERS_MAX"] ?? 3);
const IDLE_MS = Number(process.env["MAXFLOW_BROWSER_IDLE_MS"] ?? 10 * 60_000);
const CONSOLE_KEPT = 500;
const LAUNCH_DEADLINE_MS = 15_000;
const PROBE_TIMEOUT_MS = 2000;
const REAP_EVERY_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

const browsers = new Map<string, Browser>();
const starting = new Map<string, Promise<Browser>>();

export class BrowserCap extends Error {}

const profileOf = (session: string) => `browsers/${session}`;
const portFileOf = (session: string) => `${profileOf(session)}/DevToolsActivePort`;

async function devtoolsJson(port: number, path: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) throw new CdpError(`${path}: ${String(res.status)}`);
  return res.json();
}

function writtenPort(session: string): number | undefined {
  const port = Number(readStateText(portFileOf(session))?.split("\n", 1)[0]);
  return Number.isSafeInteger(port) && port > 0 ? port : undefined;
}

async function isAnswering(port: number) {
  try {
    await devtoolsJson(port, "/json/version");
    return true;
  } catch {
    return false;
  }
}

async function launchChrome(session: string): Promise<number> {
  const binary = chromeBinary();
  if (binary === undefined) throw new BrowserCap("no Chrome or Chromium on this machine: install one, or point MAXFLOW_CHROME at its binary");
  const profile = stateDirectory(profileOf(session));
  removeState(portFileOf(session));
  const flags = ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"];
  const chrome = Bun.spawn([binary, ...flags, `--window-size=${String(VIEWPORT.width)},${String(VIEWPORT.height)}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  chrome.unref();
  const end = Date.now() + LAUNCH_DEADLINE_MS;
  while (Date.now() < end) {
    if (chrome.exitCode !== null) throw new CdpError(`Chrome exited ${String(chrome.exitCode)} before it listened`);
    const port = writtenPort(session);
    if (port !== undefined && (await isAnswering(port))) return port;
    await Bun.sleep(100);
  }
  chrome.kill();
  throw new CdpError(`Chrome didn't listen within ${String(LAUNCH_DEADLINE_MS)}ms`);
}

const socketUrlOf = (target: unknown) => (isRecord(target) && typeof target["webSocketDebuggerUrl"] === "string" ? target["webSocketDebuggerUrl"] : undefined);

function firstPage(targets: unknown) {
  const listed: unknown[] = Array.isArray(targets) ? targets : [];
  return listed.find((target) => isRecord(target) && target["type"] === "page");
}

export async function pageSocketUrl(port: number): Promise<string> {
  const open = socketUrlOf(firstPage(await devtoolsJson(port, "/json/list")));
  if (open !== undefined) return open;
  const made = socketUrlOf(await unlessItFails(devtoolsJson(port, "/json/new?about:blank")));
  if (made !== undefined) return made;
  throw new CdpError("Chrome has no page to drive");
}

const describeArg = (arg: unknown) => String(isRecord(arg) ? (arg["value"] ?? arg["description"] ?? arg["type"]) : arg);

function consoleLine(method: string, params: Record<string, unknown>): string | undefined {
  if (method === "Runtime.consoleAPICalled") {
    const args: unknown[] = Array.isArray(params["args"]) ? params["args"] : [];
    return `${String(params["type"])}: ${args.map(describeArg).join(" ")}`;
  }
  if (method === "Runtime.exceptionThrown" && isRecord(params["exceptionDetails"])) {
    const details = params["exceptionDetails"];
    return `exception: ${describeArg(isRecord(details["exception"]) ? details["exception"] : details["text"])}`;
  }
  if (method === "Log.entryAdded" && isRecord(params["entry"])) return `${String(params["entry"]["level"])}: ${String(params["entry"]["text"])}`;
  return undefined;
}

async function attach(session: string, port: number): Promise<Browser> {
  const page = await Cdp.connect(await pageSocketUrl(port));
  const browser: Browser = { session, port, page, usedAt: Date.now(), console: [], watchers: 0, isHeld: false };
  page.on(({ method, params }) => {
    const line = consoleLine(method, params);
    if (line === undefined) return;
    browser.console.push(line);
    if (browser.console.length > CONSOLE_KEPT) browser.console.shift();
  });
  await Promise.all(["Page.enable", "Runtime.enable", "Log.enable"].map(async (method) => page.send(method)));
  await page.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  browsers.set(session, browser);
  publish(`browser/${session}/opened`, { session });
  return browser;
}

function unwatchedThenOldest(a: Browser, b: Browser) {
  const watchedLast = Number(a.watchers > 0) - Number(b.watchers > 0);
  return watchedLast === 0 ? a.usedAt - b.usedAt : watchedLast;
}

function leastRecentlyUsed(): Browser | undefined {
  return browsers.values().toArray().toSorted(unwatchedThenOldest)[0];
}

async function makeRoom() {
  while (browsers.size >= MAX_BROWSERS) {
    const oldest = leastRecentlyUsed();
    if (!oldest) return;
    const unusedSeconds = Math.round((Date.now() - oldest.usedAt) / 1000);
    console.log(`browsers: at the cap of ${String(MAX_BROWSERS)}, closing ${oldest.session}'s, unused for ${String(unusedSeconds)}s`);
    await closeBrowser(oldest.session);
  }
}

async function start(session: string): Promise<Browser> {
  try {
    const adoptable = writtenPort(session);
    if (adoptable !== undefined && (await isAnswering(adoptable))) return await attach(session, adoptable);
    await makeRoom();
    return await attach(session, await launchChrome(session));
  } finally {
    starting.delete(session);
  }
}

export async function browserFor(session: string): Promise<Browser> {
  const open = browsers.get(session);
  if (open && !open.page.closed) {
    open.usedAt = Date.now();
    return open;
  }
  const already = starting.get(session);
  if (already) return already;
  const pending = start(session);
  starting.set(session, pending);
  return pending;
}

export const isBrowsing = (session: string) => browsers.has(session);
export const isHeld = (session: string) => browsers.get(session)?.isHeld === true;
export const hasBrowser = (session: string) => browsers.has(session) || writtenPort(session) !== undefined;

export async function closeBrowser(session: string) {
  const port = browsers.get(session)?.port ?? writtenPort(session);
  browsers.get(session)?.page.close();
  if (browsers.delete(session)) publish(`browser/${session}/closed`, { session });
  if (port === undefined) return;
  try {
    const version = await devtoolsJson(port, "/json/version");
    if (!isRecord(version) || typeof version["webSocketDebuggerUrl"] !== "string") return;
    const chrome = await Cdp.connect(version["webSocketDebuggerUrl"]);
    await unlessItFails(chrome.send("Browser.close"));
    chrome.close();
  } catch {
    return;
  } finally {
    removeState(portFileOf(session));
  }
}

async function adoptOrClose(session: string) {
  if ((await unlessItFails(browserFor(session))) === undefined) await closeBrowser(session);
}

async function reap(session: string, isLive: boolean) {
  const browser = browsers.get(session);
  if (!isLive) {
    await closeBrowser(session);
    removeStateDirectory(profileOf(session));
  } else if (browser?.watchers === 0 && Date.now() - browser.usedAt > IDLE_MS) await closeBrowser(session);
  else if (!browser && writtenPort(session) !== undefined) await adoptOrClose(session);
}

async function reapBrowsers(isLive: (session: string) => boolean) {
  for (const { name: session } of listState("browsers")) await reap(session, isLive(session));
}

export function keepReapingBrowsers(isLive: (session: string) => boolean) {
  setInterval(() => {
    void reapNow(isLive);
  }, REAP_EVERY_MS);
}

async function reapNow(isLive: (session: string) => boolean) {
  try {
    await reapBrowsers(isLive);
  } catch (error) {
    console.error("reapBrowsers", error);
  }
}
