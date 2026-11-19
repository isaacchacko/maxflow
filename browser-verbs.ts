import type { Browser } from "./browsers";
import { CdpError } from "./cdp";
import { isRecord, stringOr } from "./shared/guards";

const LOAD_WAIT_MS = 15_000;
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|[\w-]+\.local\b)/;

export function pageUrl(input: string): string {
  const url = input.trim();
  if (url === "about:blank" || /^https?:\/\//i.test(url)) return url;
  if (/^[a-z][\w+.-]*:/i.test(url) && !/^[\w.-]+:\d/.test(url)) throw new CdpError(`${url}: only http(s) and about:blank open here`);
  return `${LOCAL_HOST.test(url) ? "http" : "https"}://${url}`;
}

async function evaluated(browser: Browser, expression: string): Promise<unknown> {
  const reply = await browser.page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const thrown = reply["exceptionDetails"];
  if (isRecord(thrown)) {
    const exception = thrown["exception"];
    throw new CdpError(String(isRecord(exception) ? (exception["description"] ?? exception["value"]) : thrown["text"]));
  }
  return isRecord(reply["result"]) ? reply["result"]["value"] : undefined;
}

export async function whereItIs(browser: Browser) {
  const at = await evaluated(browser, "({ url: location.href, title: document.title })");
  return isRecord(at) ? { url: String(at["url"]), title: String(at["title"]) } : { url: "", title: "" };
}

export async function goTo(browser: Browser, input: string) {
  const url = pageUrl(input);
  const loaded = new Promise<void>((resolve) => {
    const stop = browser.page.on(({ method }) => {
      if (method !== "Page.loadEventFired") return;
      stop();
      resolve();
    });
    setTimeout(() => {
      stop();
      resolve();
    }, LOAD_WAIT_MS);
  });
  const navigated = await browser.page.send("Page.navigate", { url });
  if (typeof navigated["errorText"] === "string") throw new CdpError(`${url}: ${navigated["errorText"]}`);
  if (typeof navigated["loaderId"] === "string") await loaded;
  return whereItIs(browser);
}

export async function screenshot(browser: Browser) {
  const shot = await browser.page.send("Page.captureScreenshot", { format: "png" });
  return new Uint8Array(Buffer.from(String(shot["data"]), "base64"));
}

export async function evalIn(browser: Browser, code: string) {
  return evaluated(browser, code);
}

export async function pageText(browser: Browser) {
  const { url, title } = await whereItIs(browser);
  return `${title}\n${url}\n\n${String(await evaluated(browser, "document.body?.innerText ?? ''"))}`;
}

type AxNode = { nodeId: string; ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; childIds?: string[] };
const SILENT_ROLES = new Set(["none", "generic", "InlineTextBox", "LineBreak", "StaticText"]);

function axLines(nodes: Map<string, AxNode>, id: string, depth: number): string[] {
  const node = nodes.get(id);
  if (!node) return [];
  const role = stringOr(node.role?.value);
  const name = stringOr(node.name?.value).trim();
  const isShown = node.ignored !== true && !SILENT_ROLES.has(role);
  const line = isShown ? [`${"  ".repeat(depth)}${role}${name === "" ? "" : ` "${name.slice(0, 120)}"`}`] : [];
  const below = (node.childIds ?? []).flatMap((child) => axLines(nodes, child, isShown ? depth + 1 : depth));
  return [...line, ...below];
}

export async function accessibilityTree(browser: Browser) {
  const reply = await browser.page.send("Accessibility.getFullAXTree");
  const nodes: AxNode[] = Array.isArray(reply["nodes"]) ? (reply["nodes"] as AxNode[]) : [];
  const root = nodes[0];
  if (!root) return "";
  return axLines(new Map(nodes.map((node) => [node.nodeId, node])), root.nodeId, 0).join("\n");
}

const FIND = `(target) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let el = null;
  try { el = document.querySelector(target); } catch {}
  if (!el) {
    const all = [...document.querySelectorAll("a, button, input, textarea, select, label, summary, [role], [onclick], [tabindex]")].filter(visible);
    const names = (e) => [e.innerText, e.value, e.getAttribute("aria-label"), e.placeholder, e.title, e.labels?.[0]?.innerText].filter(Boolean).map((n) => String(n).trim().toLowerCase());
    const want = target.trim().toLowerCase();
    el = all.find((e) => names(e).includes(want)) ?? all.find((e) => names(e).some((n) => n.includes(want))) ?? null;
  }
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, what: el.tagName.toLowerCase() + (el.innerText ? ' "' + el.innerText.trim().slice(0, 60) + '"' : "") };
}`;

async function locate(browser: Browser, target: string) {
  const found = await evaluated(browser, `(${FIND})(${JSON.stringify(target)})`);
  if (!isRecord(found)) throw new CdpError(`nothing on the page matches ${JSON.stringify(target)}, as a CSS selector or as visible text`);
  return { x: Number(found["x"]), y: Number(found["y"]), what: String(found["what"]) };
}

async function clickAt(browser: Browser, x: number, y: number) {
  for (const type of ["mousePressed", "mouseReleased"]) await browser.page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

export async function click(browser: Browser, target: string) {
  const { x, y, what } = await locate(browser, target);
  await clickAt(browser, x, y);
  return `clicked ${what}`;
}

export async function pressEnter(browser: Browser) {
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await browser.page.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r", unmodifiedText: "\r" });
  await browser.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
}

export async function typeInto(browser: Browser, target: string, text: string, isSubmitting: boolean) {
  const { x, y, what } = await locate(browser, target);
  await clickAt(browser, x, y);
  const isFocused = (await evaluated(browser, "document.activeElement !== document.body && document.activeElement !== null")) === true;
  if (!isFocused) throw new CdpError(`clicked ${what}, but nothing took focus to type into`);
  await evaluated(browser, "document.activeElement.select?.()");
  await browser.page.send("Input.insertText", { text });
  if (isSubmitting) await pressEnter(browser);
  return `typed into ${what}${isSubmitting ? ", then Enter" : ""}`;
}
