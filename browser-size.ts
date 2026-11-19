import type { Browser } from "./browsers";
import { CdpError } from "./cdp";
import { isRecord, stringOr } from "./shared/guards";
import { peekStateJson, writeStateJson } from "./state";

export type Size = { name: string; width: number; height: number; mobile: boolean; dpr: number };
export type View = { size: Size; zoom: number };

export const SIZES: Record<string, Size> = {
  phone: { name: "phone", width: 390, height: 844, mobile: true, dpr: 3 },
  tablet: { name: "tablet", width: 768, height: 1024, mobile: false, dpr: 1 },
  laptop: { name: "laptop", width: 1280, height: 800, mobile: false, dpr: 1 },
  desktop: { name: "desktop", width: 1920, height: 1080, mobile: false, dpr: 1 },
};
export const FIRST_VIEW: View = { size: SIZES["laptop"] ?? { name: "laptop", width: 1280, height: 800, mobile: false, dpr: 1 }, zoom: 1 };

const SIDE = { min: 200, max: 3840 };
const ZOOM = { min: 0.25, max: 3, step: 0.25 };
const CUSTOM = /^(\d+)x(\d+)$/i;

const TOUCH_POINTS = 5;
const desktopAgents = new WeakMap<Browser, string>();

async function desktopAgentOf(browser: Browser) {
  const known = desktopAgents.get(browser);
  if (known !== undefined) return known;
  const reply = await browser.page.send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
  const agent = isRecord(reply["result"]) ? stringOr(reply["result"]["value"]) : "";
  desktopAgents.set(browser, agent);
  return agent;
}

export function phoneAgentFrom(desktop: string) {
  const version = /Chrome\/([\d.]+)/.exec(desktop)?.[1] ?? "0.0.0.0";
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`;
}

const viewFileOf = (session: string) => `browsers/${session}/view.json`;
const views = new Map<string, View>();
const news = new Map<string, string>();

export const viewOf = (browser: Browser) => views.get(browser.session) ?? FIRST_VIEW;

export function tellAgent(browser: Browser, said: string) {
  news.set(browser.session, said);
}

export function takeNews(browser: Browser) {
  const said = news.get(browser.session);
  news.delete(browser.session);
  return said;
}

export function parseSize(asked: string): Size {
  const preset = Object.hasOwn(SIZES, asked.toLowerCase()) ? SIZES[asked.toLowerCase()] : undefined;
  if (preset) return preset;
  const [, width = "", height = ""] = CUSTOM.exec(asked.trim()) ?? [];
  const sides = [Number(width), Number(height)];
  if (width === "" || sides.some((side) => side < SIDE.min || side > SIDE.max)) {
    throw new CdpError(`${asked}: give a size as ${Object.keys(SIZES).join(", ")} or WxH, each side ${String(SIDE.min)}-${String(SIDE.max)}`);
  }
  return { name: "custom", width: Number(width), height: Number(height), mobile: false, dpr: 1 };
}

export const zoomWithin = (zoom: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(zoom / ZOOM.step) * ZOOM.step));

export const layoutOf = ({ size, zoom }: View) => ({ width: Math.round(size.width / zoom), height: Math.round(size.height / zoom) });

export function describeView(view: View) {
  const { size, zoom } = view;
  const named = size.name === "custom" ? "" : `${size.name} `;
  const mobile = size.mobile ? `, mobile at ${String(size.dpr)}x` : "";
  const zoomed = zoom === 1 ? "" : ` at ${String(Math.round(zoom * 100))}% zoom`;
  return `${named}${String(size.width)}x${String(size.height)}${mobile}${zoomed}`;
}

export const viewMessage = (view: View) => JSON.stringify({ type: "size", name: view.size.name, width: view.size.width, height: view.size.height, zoom: view.zoom, layout: layoutOf(view) });

function isView(value: unknown): value is View {
  if (!isRecord(value) || typeof value["zoom"] !== "number" || !isRecord(value["size"])) return false;
  const size = value["size"];
  return typeof size["name"] === "string" && typeof size["width"] === "number" && typeof size["height"] === "number" && typeof size["mobile"] === "boolean" && typeof size["dpr"] === "number";
}

export function keptView(session: string): View {
  const kept = peekStateJson(viewFileOf(session));
  return isView(kept) ? kept : FIRST_VIEW;
}

async function emulate(browser: Browser, view: View) {
  const layout = layoutOf(view);
  const screenOrientation = layout.width > layout.height ? { type: "landscapePrimary", angle: 90 } : { type: "portraitPrimary", angle: 0 };
  const metrics = { ...layout, screenWidth: layout.width, screenHeight: layout.height, screenOrientation, deviceScaleFactor: view.size.dpr * view.zoom, mobile: view.size.mobile };
  const desktop = await desktopAgentOf(browser);
  await browser.page.send("Emulation.setDeviceMetricsOverride", metrics);
  await browser.page.send("Emulation.setTouchEmulationEnabled", { enabled: view.size.mobile, maxTouchPoints: view.size.mobile ? TOUCH_POINTS : 1 });
  await browser.page.send("Emulation.setUserAgentOverride", { userAgent: view.size.mobile ? phoneAgentFrom(desktop) : desktop });
}

export async function applyView(browser: Browser, view: View) {
  await emulate(browser, view);
  views.set(browser.session, view);
  writeStateJson(viewFileOf(browser.session), view);
  for (const resized of browser.resized) resized();
}

export async function resize(browser: Browser, asked: string) {
  if (asked.trim() !== "") await applyView(browser, { ...viewOf(browser), size: parseSize(asked) });
  news.delete(browser.session);
  return describeView(viewOf(browser));
}
