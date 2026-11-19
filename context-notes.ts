import { join } from "node:path";
import { readStateText, slackMessagesTable, stateDirectory } from "./state";

export const CONTEXT_FILE = join(stateDirectory("."), "context.md");
const MAX_NOTES = 8;
const COMMON_WORDS = new Set("isaac about after again also been before being could does doing done from have here just know like make more need only other really should some sorry than thanks that their them then there these they thing think this those time want what when where which while will with would your".split(" "));

const words = (text: string) => new Set((text.toLowerCase().match(/[a-zà-ÿ][\wà-ÿ'-]{3,}/g) ?? []).filter((w) => !COMMON_WORDS.has(w)));
const ids = (text: string) => new Set((text.match(/\b([A-Z]{2,6}-\d+|th-[0-9a-f]{6}|#\d{3,6}|o-\w+)\b/g) ?? []).map((x) => x.toLowerCase()));

type Bullet = { section: string; line: string };

function bulletsWithIndentedLines(notes: string): Bullet[] {
  let section = "";
  const bullets: Bullet[] = [];
  for (const line of notes.split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    else if (/^[-*] /.test(line)) bullets.push({ section, line });
    else if (/^\s+\S/.test(line)) {
      const last = bullets.at(-1);
      if (last) last.line += `\n${line}`;
    }
  }
  return bullets;
}

function documentFrequency(texts: string[]) {
  const frequency = new Map<string, number>();
  for (const text of texts) for (const w of words(text)) frequency.set(w, (frequency.get(w) ?? 0) + 1);
  return frequency;
}

type MessageClues = { names: RegExp[]; said: Set<string>; refs: Set<string>; frequency: Map<string, number> };

function bulletScore(line: string, clues: MessageClues) {
  const isNamed = clues.names.some((n) => n.test(line));
  const shared = [...words(line)].filter((w) => clues.said.has(w)).reduce((n, w) => n + ((clues.frequency.get(w) ?? 0) <= 2 ? 2 : 1), 0);
  return (isNamed ? 3 : 0) + 3 * [...ids(line)].filter((r) => clues.refs.has(r)).length + shared;
}

export function contextNotes(text: string, who = "") {
  const notes = readStateText("context.md");
  if (notes === undefined) return [];
  const names = who.split(/\s+/).filter((n) => n.length >= 3).map((n) => new RegExp(String.raw`\b${n.replaceAll(/\W/g, "")}\b`, "i"));
  const bullets = bulletsWithIndentedLines(notes);
  const clues = { names, said: words(text), refs: ids(text), frequency: documentFrequency(bullets.map((b) => b.line)) };
  const hits = bullets.map((b) => ({ ...b, score: bulletScore(b.line, clues) })).filter((hit) => hit.score >= 2);
  const top = hits.toSorted((a, b) => b.score - a.score).slice(0, MAX_NOTES);
  return bullets.filter((b) => top.some((t) => t.line === b.line)).map((b) => `${b.section ? `[${b.section}] ` : ""}${b.line}`);
}

export function contextBlock(text: string, who?: string) {
  const notes = contextNotes(text, who);
  return notes.length > 0 ? `\n[maxflow] What the context sentry's notes (${CONTEXT_FILE}) hold on the people and topics in it:\n${notes.join("\n")}` : "";
}

export type SlackSaid = { at: number; who: string; where: string; text: string; link: string };
const slackTs = (link: string) => /\/p(\d+)/.exec(link)?.[1] ?? link;
const spokenPart = (handOff: string) => (handOff.split("\n\nNew:\n", 2)[1] ?? handOff.replace(/^[^\n]*:\n/, "")).replaceAll(/https?:\/\/\S+/g, "");

export function relatedSlack(text: string, who: string | undefined, all: SlackSaid[], max = 5) {
  const said = spokenPart(text);
  const day = new Map(all.toReversed().map((m) => [slackTs(m.link), m])).values().toArray();
  const names = new Set(day.flatMap((m) => [...words(m.who)]));
  const mine = words(said);
  const refs = ids(said);
  const frequency = documentFrequency(day.map((m) => m.text));
  const rare = [...mine].filter((w) => w.length >= 5 && !names.has(w) && (frequency.get(w) ?? 0) <= 3);
  const out: { m: SlackSaid; on: string[] }[] = [];
  for (const m of day) {
    if (m.who === who || said.includes(m.text.slice(0, 80))) continue;
    const on = [...rare.filter((w) => words(m.text).has(w)), ...ids(m.text).intersection(refs)];
    if (on.length > 0) out.push({ m, on });
  }
  return out.toSorted((a, b) => b.m.at - a.m.at).slice(0, max);
}

function relatedLine(m: SlackSaid, threadOf?: (link: string) => string | undefined) {
  const thread = threadOf?.(m.link);
  const inThread = thread === undefined || thread === "" ? "" : ` (in thread ${thread})`;
  return `- ${new Date(m.at).toISOString().slice(5, 16).replace("T", " ")}Z ${m.who} in ${m.where}: "${m.text.replaceAll(/\s+/g, " ").slice(0, 300)}" ${m.link}${inThread}`;
}

export function relatedBlock(text: string, who: string | undefined, day: SlackSaid[], threadOf?: (link: string) => string | undefined) {
  const hits = relatedSlack(text, who, day);
  if (hits.length === 0) return "";
  return `\n[maxflow] Said on Slack in the last day by others, sharing "${[...new Set(hits.flatMap((h) => h.on))].join('", "')}" with it (likely the same thing; join them):\n${hits.map(({ m }) => relatedLine(m, threadOf)).join("\n")}`;
}

const slackDisplayText = (text: string) =>
  text
    .replace(/\s*No thread mess+ages\s*$/, "")
    .replaceAll(/<@\w+\|([^>]+)>/g, "@$1")
    .replaceAll(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replaceAll(/<(https?:[^>]+)>/g, "$1");

export function slackStoreDay(): SlackSaid[] {
  const store = slackMessagesTable.all();
  const uidsEverMarkedBot = new Set(Object.values(store).flatMap((t) => t.msgs.filter((m) => m.bot === true || /^(B|USLACKBOT)/.test(m.uid)).map((m) => m.uid)));
  return Object.entries(store)
    .filter(([target]) => !target.startsWith("search:"))
    .flatMap(([target, { title, msgs }]) => {
      const channel = target.split("/", 1)[0] ?? target;
      return msgs
        .filter((m) => !uidsEverMarkedBot.has(m.uid) && Date.now() - Number(m.ts) * 1000 < 86_400_000)
        .map((m) => ({
          at: Number(m.ts) * 1000,
          who: m.who,
          where: channel.startsWith("D") ? "DM" : title.replaceAll(/<@\w+\|([^>]+)>/g, "@$1"),
          text: slackDisplayText(m.text),
          link: m.link ?? `https://dryftai.slack.com/archives/${channel}/p${m.ts.replace(".", "")}`,
        }));
    });
}
