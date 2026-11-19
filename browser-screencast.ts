import type { ServerWebSocket } from "bun";
import { goTo, whereItIs } from "./browser-verbs";
import { browserFor, hasBrowser, type Browser } from "./browsers";
import { unlessItFails, type CdpEvent } from "./cdp";
import { isRecord } from "./shared/guards";
import type { WsData } from "./sessions";

type Viewer = ServerWebSocket<WsData>;
type Cast = { browser: Browser; viewers: Set<Viewer>; stopListening: () => void; holder?: Viewer | undefined };

const FRAME = { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 800 };
const casts = new Map<string, Cast>();
const castStarts = new Map<string, Promise<Cast>>();

function toEveryViewer(cast: Cast, message: string | Uint8Array) {
  for (const viewer of cast.viewers) {
    if (typeof message === "string") viewer.sendText(message);
    else viewer.sendBinary(message);
  }
}

async function tellWhereItIs(cast: Cast) {
  toEveryViewer(cast, JSON.stringify({ type: "page", ...(await whereItIs(cast.browser)) }));
}

function onPageEvent(cast: Cast, { method, params }: CdpEvent) {
  if (method === "closed") {
    for (const viewer of cast.viewers) viewer.close(1000, "the browser closed");
    return;
  }
  if (method === "Page.screencastFrame") {
    void unlessItFails(cast.browser.page.send("Page.screencastFrameAck", { sessionId: params["sessionId"] }));
    toEveryViewer(cast, Buffer.from(String(params["data"]), "base64"));
    return;
  }
  const isMainFrame = method === "Page.frameNavigated" && isRecord(params["frame"]) && params["frame"]["parentId"] === undefined;
  if (isMainFrame || method === "Page.navigatedWithinDocument" || method === "Page.loadEventFired") void unlessItFails(tellWhereItIs(cast));
}

async function startCast(session: string): Promise<Cast> {
  const browser = await browserFor(session);
  const cast: Cast = { browser, viewers: new Set(), stopListening: () => false };
  cast.stopListening = browser.page.on((event) => {
    onPageEvent(cast, event);
  });
  casts.set(session, cast);
  await browser.page.send("Page.startScreencast", FRAME);
  return cast;
}

async function sharedStart(session: string) {
  const starting = castStarts.get(session) ?? startCast(session);
  castStarts.set(session, starting);
  try {
    return await starting;
  } finally {
    castStarts.delete(session);
  }
}

async function watch(viewer: Viewer) {
  const cast = casts.get(viewer.data.id) ?? (await sharedStart(viewer.data.id));
  cast.viewers.add(viewer);
  cast.browser.watchers = cast.viewers.size;
  await tellWhereItIs(cast);
  viewer.sendText(JSON.stringify({ type: "held", isHeld: cast.holder !== undefined }));
}

export async function openViewer(viewer: Viewer) {
  if (!hasBrowser(viewer.data.id)) {
    viewer.close(1000, "no browser open");
    return;
  }
  try {
    await watch(viewer);
  } catch (error) {
    viewer.close(1011, error instanceof Error ? error.message : String(error));
  }
}

export function closeViewer(viewer: Viewer) {
  const cast = casts.get(viewer.data.id);
  if (!cast) return;
  cast.viewers.delete(viewer);
  cast.browser.watchers = cast.viewers.size;
  if (cast.holder === viewer) hold(viewer, false);
  if (cast.viewers.size > 0) return;
  cast.stopListening();
  casts.delete(viewer.data.id);
  void unlessItFails(cast.browser.page.send("Page.stopScreencast"));
}

async function stepThroughHistory(browser: Browser, step: number) {
  const history = await browser.page.send("Page.getNavigationHistory");
  const entries: unknown[] = Array.isArray(history["entries"]) ? history["entries"] : [];
  const entry: unknown = entries[Number(history["currentIndex"]) + step];
  if (isRecord(entry)) await browser.page.send("Page.navigateToHistoryEntry", { entryId: entry["id"] });
}

function hold(viewer: Viewer, isTaking: boolean) {
  const cast = casts.get(viewer.data.id);
  if (!cast || (!isTaking && cast.holder !== viewer)) return;
  cast.holder = isTaking ? viewer : undefined;
  cast.browser.isHeld = isTaking;
  toEveryViewer(cast, JSON.stringify({ type: "held", isHeld: isTaking }));
}

const INPUT_METHODS: Record<string, string> = { mouse: "Input.dispatchMouseEvent", wheel: "Input.dispatchMouseEvent", key: "Input.dispatchKeyEvent", text: "Input.insertText" };

function inputParams(asked: Record<string, unknown>) {
  const { type, kind, keyCode, deltaX, deltaY, ...rest } = asked;
  if (type === "wheel") return { ...rest, type: "mouseWheel", deltaX, deltaY };
  if (type === "key") return { ...rest, type: kind, windowsVirtualKeyCode: keyCode, unmodifiedText: rest["text"] };
  return type === "text" ? rest : { ...rest, type: kind };
}

async function didForwardInput(cast: Cast, viewer: Viewer, asked: Record<string, unknown>) {
  const type = String(asked["type"]);
  const method = Object.hasOwn(INPUT_METHODS, type) ? INPUT_METHODS[type] : undefined;
  if (method === undefined || cast.holder !== viewer) return false;
  await cast.browser.page.send(method, inputParams(asked));
  return true;
}

const NAVIGATIONS: Record<string, (browser: Browser, asked: Record<string, unknown>) => Promise<unknown>> = {
  goto: async (browser, asked) => goTo(browser, String(asked["url"])),
  back: async (browser) => stepThroughHistory(browser, -1),
  forward: async (browser) => stepThroughHistory(browser, 1),
  reload: async (browser) => browser.page.send("Page.reload"),
};

async function doAsked(cast: Cast, viewer: Viewer, asked: Record<string, unknown>) {
  if (asked["type"] === "hold") {
    hold(viewer, asked["isTaking"] === true);
    return;
  }
  if (await didForwardInput(cast, viewer, asked)) return;
  const type = String(asked["type"]);
  if (Object.hasOwn(NAVIGATIONS, type)) await NAVIGATIONS[type]?.(cast.browser, asked);
}

export async function viewerAsked(viewer: Viewer, raw: string) {
  const cast = casts.get(viewer.data.id);
  const asked: unknown = JSON.parse(raw);
  if (!cast || !isRecord(asked)) return;
  cast.browser.usedAt = Date.now();
  try {
    await doAsked(cast, viewer, asked);
  } catch (error) {
    viewer.sendText(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
  }
}
