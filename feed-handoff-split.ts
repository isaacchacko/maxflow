import { slackMessagesTable } from "./state";
import { threads } from "./stores";
import { patch } from "./patch";
import type { Message, Thread } from "./model";

type External = NonNullable<Message["ext"]>;
type Source = External["source"];
type SlackStore = { uidByName: Map<string, string>; rawTextByTs: Map<string, string> };
type Handoff = { who: string; where: string; source: Source; links: string[]; before: string; now: string };

const HANDOFF_HEAD = /^.+? in .+?:\n(Before it, in the same conversation|> )/;
const HANDOFF_PARTS = /^(.+?) in (.+?):\n([\s\S]*)$/;
const HANDOFF_SOURCE_LINK = /^https:\/\/(\S+\.slack\.com|github\.com)\//m;
const LINK_LINES = /^https?:\/\/\S+$/gm;
const NEW_SECTION = "\n\nNew:\n";
const CONTEXT_QUOTE = /^> \*\*(.+?):\*\* ?([\s\S]*)$/;
const SLACK_PERMALINK_TS = /\/p(\d+)/;

const isHandoffText = (m: Message) => m.ext === undefined && m.from !== "isaac" && HANDOFF_HEAD.test(m.text) && HANDOFF_SOURCE_LINK.test(m.text);
const unquote = (text: string) => text.replaceAll(/^> ?/gm, "").trim();
const permalinkTs = (link = "") => SLACK_PERMALINK_TS.exec(link)?.[1] ?? "";
const freshMessageId = () => `m-${crypto.randomUUID().slice(0, 6)}`;

function readSlackStore(): SlackStore {
  const store: SlackStore = { uidByName: new Map(), rawTextByTs: new Map() };
  let kept: ReturnType<typeof slackMessagesTable.all>;
  try {
    kept = slackMessagesTable.all();
  } catch {
    return store;
  }
  for (const { msgs } of Object.values(kept))
    for (const m of msgs) {
      if (!store.uidByName.has(m.who)) store.uidByName.set(m.who, m.uid);
      const ts = m.ts.replace(".", "");
      if (!store.rawTextByTs.has(ts)) store.rawTextByTs.set(ts, m.text.replace(/\s*No thread mess+ages\s*$/, ""));
    }
  return store;
}

function sourceOf(t: Thread, m: Message): Source {
  const isSlack = t.feed === undefined ? m.text.includes(".slack.com/") : t.feed.source === "slack";
  return isSlack ? "slack" : "github";
}

function handoffOf(t: Thread, m: Message): Handoff | undefined {
  if (!isHandoffText(m)) return undefined;
  const head = HANDOFF_PARTS.exec(m.text);
  if (!head) return undefined;
  const [, who = "", where = "", rest = ""] = head;
  const body = rest.replaceAll(LINK_LINES, "").trim();
  const [before = "", now = ""] = body.includes(NEW_SECTION) ? body.split(NEW_SECTION, 2) : ["", body];
  return { who, where, source: sourceOf(t, m), links: rest.match(LINK_LINES) ?? [t.feed?.link ?? ""], before, now };
}

function contextExt(h: Handoff, store: SlackStore, quoted: string): External {
  const isHis = quoted.startsWith("Isaac (him");
  const name = isHis ? "Isaac" : quoted;
  const uid = h.source === "slack" ? store.uidByName.get(name) : undefined;
  const user = h.source === "github" && !isHis ? name : uid;
  return { source: h.source, name, ...(user !== undefined && user !== "" && { user }), link: h.links[0] ?? "", where: h.where, context: true, ...(isHis && { own: true as const }) };
}

function contextMessage(m: Message, h: Handoff, store: SlackStore, quote: string): Message | undefined {
  const [, quoted = "", said = ""] = CONTEXT_QUOTE.exec(quote) ?? [];
  const text = unquote(said);
  if (text === "") return undefined;
  return { id: freshMessageId(), from: "feed", at: m.at, text, ext: contextExt(h, store, quoted) };
}

function contextMessages(m: Message, h: Handoff, store: SlackStore): Message[] {
  const quotes = h.before.replace(/^Before it[^\n]*\n/, "").split(/\n(?=> \*\*)/).filter((x) => x.trim() !== "");
  return quotes.map((quote) => contextMessage(m, h, store, quote)).filter((said) => said !== undefined);
}

function newMessages(m: Message, h: Handoff, store: SlackStore): Message[] {
  const split = h.now.split(/\n(?=> )/).map(unquote).filter((line) => line !== "");
  const hasLinkForEach = split.length === h.links.length;
  const lines = hasLinkForEach ? split : [unquote(h.now)];
  const uid = h.source === "slack" ? store.uidByName.get(h.who) : h.who;
  return lines.map((text, i) => {
    const raw = lines.length === h.links.length ? store.rawTextByTs.get(permalinkTs(h.links[i])) : undefined;
    const link = h.links[Math.min(i, h.links.length - 1)] ?? "";
    return { id: i === 0 ? m.id : `${m.id}-${String(i)}`, from: "feed", at: m.at, text: raw === undefined || raw === "" ? text : raw, ext: { source: h.source, name: h.who, ...(uid !== undefined && uid !== "" && { user: uid }), link, where: h.where } };
  });
}

function splitHandoffsOf(t: Thread, store: SlackStore) {
  const handoffTexts = t.messages.filter(isHandoffText).map((m) => m.text);
  if (handoffTexts.length === 0) return;
  if (t.feed) patch(t, { feedSaid: [...(t.feedSaid ?? []), ...handoffTexts.filter((text) => t.feedSaid?.includes(text) !== true)] });
  const messages = t.messages.flatMap((m) => {
    const h = handoffOf(t, m);
    if (!h) return [m];
    const out = [...contextMessages(m, h, store), ...newMessages(m, h, store)];
    return out.length > 0 ? out : [m];
  });
  patch(t, { messages });
}

function restoreSlackTextOfSplitMessages(t: Thread, store: SlackStore) {
  for (const m of t.messages) {
    const ts = m.ext?.source === "slack" && m.ext.context !== true ? permalinkTs(m.ext.link) : "";
    const raw = ts === "" ? undefined : store.rawTextByTs.get(ts);
    if (raw !== undefined && !m.text.includes("\n") && raw.includes("\n")) patch(m, { text: raw });
  }
}

export function splitFeedHandoffsIntoTheirMessages() {
  const store = readSlackStore();
  for (const t of threads) splitHandoffsOf(t, store);
  for (const t of threads) restoreSlackTextOfSplitMessages(t, store);
}
