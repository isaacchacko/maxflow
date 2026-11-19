const PAGES = new Map([
  ["inbox", "Threads"],
  ["todo", "Todo"],
  ["routing", "Routing"],
  ["sentries", "Sentries"],
]);

const SCREENSHOT_LINE = /^\[maxflow · screenshot\] (.*)$/m;
const PAGE_PART = /^page (.*)$/;
const PAGE_HASH = /^`#?([\w-]+)`$/;
const MESSAGE_PART = /^message from (.+?) at [\d:]+/;
const ELEMENT_PART = /^element `(.*)`$/;

function readablePart(part: string) {
  const page = PAGE_PART.exec(part);
  if (page) {
    const where = page[1] ?? "";
    const hash = PAGE_HASH.exec(where)?.[1];
    return `from ${hash === undefined ? where : (PAGES.get(hash) ?? hash)}`;
  }
  const message = MESSAGE_PART.exec(part);
  if (message) return message[1] === "Isaac" ? "on your message" : `on ${message[1] ?? ""}'s message`;
  return part;
}

export function splitCapture(text: string) {
  const line = SCREENSHOT_LINE.exec(text);
  if (!line) return { body: text };
  const body = text.replace(line[0], "").replaceAll(/\n{3,}/g, "\n\n").trim();
  const parts = (line[1] ?? "").split(" · ");
  const element = parts.map(part => ELEMENT_PART.exec(part)?.[1]).findLast(e => e !== undefined);
  const caption = parts
    .filter(part => !ELEMENT_PART.test(part))
    .map(readablePart)
    .join(" · ");
  return { body, caption, element };
}
