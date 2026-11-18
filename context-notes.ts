// The context sentry's notes ($MAXFLOW_STATE/context.md, kept by sentries/context.md) that bear on a message: the bullets naming its
// sender, or one of its identifiers (PRO-1234, #123, th-abc123), or enough of its words. Each comes back under its section's heading.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./instance";

export const CONTEXT_FILE = join(STATE_DIR, "context.md");
const MAX = 8;
// Words too common to tie a message to a note.
const COMMON = new Set("isaac about after again also been before being could does doing done from have here just know like make more need only other really should some sorry than thanks that their them then there these they thing think this those time want what when where which while will with would your".split(" "));

const words = (text: string) => new Set((text.toLowerCase().match(/[a-zà-ÿ][\wà-ÿ'-]{3,}/g) ?? []).filter((w) => !COMMON.has(w)));
const ids = (text: string) => new Set((text.match(/\b([A-Z]{2,6}-\d+|th-[0-9a-f]{6}|#\d{3,6}|o-\w+)\b/g) ?? []).map((x) => x.toLowerCase()));

export function contextNotes(text: string, who?: string) {
  if (!existsSync(CONTEXT_FILE)) return [];
  const names = (who ?? "").split(/\s+/).filter((n) => n.length >= 3).map((n) => new RegExp(`\\b${n.replace(/\W/g, "")}\\b`, "i"));
  const said = words(text), refs = ids(text);
  const hits: { section: string; line: string; score: number }[] = [];
  let section = "";
  // A bullet is its line and the indented lines under it.
  const bullets: { section: string; line: string }[] = [];
  for (const line of readFileSync(CONTEXT_FILE, "utf8").split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    else if (/^[-*] /.test(line)) bullets.push({ section, line });
    else if (/^\s+\S/.test(line) && bullets.length) bullets.at(-1)!.line += `\n${line}`;
  }
  // A word in only a couple of notes (a name for a thing, like "excalidraw") ties a message to them on its own.
  const df = new Map<string, number>();
  for (const b of bullets) for (const w of words(b.line)) df.set(w, (df.get(w) ?? 0) + 1);
  for (const b of bullets) {
    const named = names.some((n) => n.test(b.line));
    const shared = [...words(b.line)].filter((w) => said.has(w)).reduce((n, w) => n + (df.get(w)! <= 2 ? 2 : 1), 0);
    const score = (named ? 3 : 0) + 3 * [...ids(b.line)].filter((r) => refs.has(r)).length + shared;
    if (score >= 2) hits.push({ ...b, score });
  }
  const top = hits.sort((a, b) => b.score - a.score).slice(0, MAX);
  return bullets.filter((b) => top.some((t) => t.line === b.line)).map((b) => `${b.section ? `[${b.section}] ` : ""}${b.line}`);
}

// The block a hand-off carries, or "" when the notes have nothing on it.
export function contextBlock(text: string, who?: string) {
  const notes = contextNotes(text, who);
  return notes.length ? `\n[maxflow] What the context sentry's notes (${CONTEXT_FILE}) hold on the people and topics in it:\n${notes.join("\n")}` : "";
}

// Slack messages from the last day, from other people, that share a rare noun with this one (a thing's name like "excalidraw", a ticket
// or PR id): often what it answers, said elsewhere (Chris asks in a channel to share the excalidraw; Max DMs to edit it before sending).
// A word counts as rare when at most 3 of the day's messages use it.
export type SlackSaid = { at: number; who: string; where: string; text: string; link: string };
export function relatedSlack(text: string, who: string | undefined, all: SlackSaid[], max = 5) {
  // Only what was said: a hand-off's "<who> in <where>:" line and the context before "New:" aren't.
  const said = (text.split("\n\nNew:\n")[1] ?? text.replace(/^[^\n]*:\n/, "")).replace(/https?:\/\/\S+/g, "");
  const ts = (link: string) => link.match(/\/p(\d+)/)?.[1] ?? link;
  const day = [...new Map(all.toReversed().map((m) => [ts(m.link), m])).values()];
  const names = new Set(day.flatMap((m) => [...words(m.who)]));
  const mine = words(said), refs = ids(said);
  const df = new Map<string, number>();
  for (const m of day) for (const w of words(m.text)) df.set(w, (df.get(w) ?? 0) + 1);
  const rare = [...mine].filter((w) => w.length >= 5 && !names.has(w) && (df.get(w) ?? 0) <= 3);
  const out: { m: SlackSaid; on: string[] }[] = [];
  for (const m of day) {
    if (m.who === who || said.includes(m.text.slice(0, 80))) continue;
    const on = [...rare.filter((w) => words(m.text).has(w)), ...[...ids(m.text)].filter((r) => refs.has(r))];
    if (on.length) out.push({ m, on });
  }
  return out.sort((a, b) => b.m.at - a.m.at).slice(0, max);
}
export function relatedBlock(text: string, who: string | undefined, day: SlackSaid[], threadOf: (link: string) => string | undefined = () => undefined) {
  const hits = relatedSlack(text, who, day);
  return hits.length
    ? `\n[maxflow] Said on Slack in the last day by others, sharing "${[...new Set(hits.flatMap((h) => h.on))].join('", "')}" with it (likely the same thing; join them):\n${hits.map(({ m }) => `- ${new Date(m.at).toISOString().slice(5, 16).replace("T", " ")}Z ${m.who} in ${m.where}: "${m.text.replace(/\s+/g, " ").slice(0, 300)}" ${m.link}${threadOf(m.link) ? ` (in thread ${threadOf(m.link)})` : ""}`).join("\n")}`
    : "";
}

// The last day of what the slack sentry read into its store (sentries/slack.ts), which also holds what no event carried.
export function slackStoreDay(): SlackSaid[] {
  const file = join(STATE_DIR, "slack-messages.json");
  if (!existsSync(file)) return [];
  const store = JSON.parse(readFileSync(file, "utf8")) as Record<string, { title: string; msgs: { ts: string; uid: string; who: string; text: string; link?: string; bot?: boolean }[] }>;
  // An app (Linear, a QA agent) is marked a bot on some of its messages only.
  const bots = new Set(Object.values(store).flatMap((t) => t.msgs.filter((m) => m.bot || /^(B|USLACKBOT)/.test(m.uid)).map((m) => m.uid)));
  return Object.entries(store).filter(([target]) => !target.startsWith("search:")).flatMap(([target, { title, msgs }]) => {
    const [channel, thread] = target.split("/");
    return msgs.filter((m) => !bots.has(m.uid) && Date.now() - Number(m.ts) * 1000 < 86_400_000).map((m) => ({
      at: Number(m.ts) * 1000,
      who: m.who,
      where: channel.startsWith("D") ? "DM" : title.replace(/<@\w+\|([^>]+)>/g, "@$1"),
      text: m.text.replace(/\s*No thread mess+ages\s*$/, "").replace(/<@\w+\|([^>]+)>/g, "@$1").replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2").replace(/<(https?:[^>]+)>/g, "$1"),
      link: m.link ?? `https://dryftai.slack.com/archives/${channel}/p${m.ts.replace(".", "")}`,
    }));
  });
}
