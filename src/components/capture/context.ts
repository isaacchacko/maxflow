import { elementAtMiddle, type Rect } from "./region";

const ENTITY = /^#(thread|agent|objective|task)\/([^/?#]+)(\/.*)?$/;
const chip = (kind: string, id: string) => `[[${kind}:${decodeURIComponent(id)}]]`;

type Entity = { kind: string; id: string; rest: string | undefined };

function entityIn(href: string | null | undefined): Entity | undefined {
  const match = ENTITY.exec(href ?? "");
  if (!match) return;
  const [, kind = "", id = "", rest] = match;
  return { kind, id, rest };
}

function pagePart(hash: string, page: Entity | undefined) {
  if (!page) return `page \`${hash}\``;
  const subpage = page.rest === undefined || page.rest === "" ? "" : ` (${page.rest.slice(1)})`;
  return `page ${chip(page.kind, page.id)}${subpage}`;
}

function messagePart(message: HTMLElement) {
  const from = message.dataset["from"] ?? "";
  const words = message.querySelector(".leading-relaxed")?.textContent.trim().replaceAll(/\s+/g, " ").slice(0, 80);
  const quotedWords = words === undefined || words === "" ? "" : ` ("${words}…")`;
  return `message from ${from === "isaac" ? "Isaac" : chip("agent", from)} at ${message.dataset["at"]?.slice(11, 16)}${quotedWords}`;
}

const isSameEntity = (link: Entity, kind: string | undefined, id: string | undefined) => link.kind === kind && link.id === id;

function linkNear(el: Element | undefined, message: HTMLElement | null | undefined) {
  return entityIn(el?.closest<HTMLAnchorElement>("a[href^='#']")?.getAttribute("href")) ?? entityIn(message?.querySelector<HTMLAnchorElement>("a[href^='#']")?.getAttribute("href"));
}

function elementPart(el: Element | undefined) {
  const marked = el?.closest<HTMLElement>("[data-agent]")?.dataset["agent"];
  return marked === undefined || marked === "" ? [] : [`element \`${marked}\``];
}

export function whereTheShotWasTaken(rect: Rect, overlay: Element | null) {
  const hash = location.hash === "" ? "#inbox" : location.hash;
  const page = entityIn(hash);
  const parts = [pagePart(hash, page)];
  const el = elementAtMiddle(rect, overlay);
  const message = el?.closest<HTMLElement>("article[data-from]");
  if (message) parts.push(messagePart(message));
  const link = linkNear(el, message);
  if (link && !isSameEntity(link, page?.kind, page?.id) && !isSameEntity(link, "agent", message?.dataset["from"])) parts.push(`pointing at ${chip(link.kind, link.id)}`);
  parts.push(...elementPart(el));
  return `[maxflow · screenshot] ${parts.join(" · ")}`;
}
