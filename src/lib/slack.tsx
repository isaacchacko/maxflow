import { createStore } from "@/store";
import { isRecord } from "../../shared/guards";
import { emojiOf, SHORTCODE } from "./emoji";
import { cn, hasText } from "./utils";

export const slackNameStore = createStore<Record<string, string>>({});
const slackNamesLoad = { at: 0 };

async function fetchSlackNames() {
  try {
    const r = await fetch("/api/slack/names");
    const names: unknown = r.ok ? await r.json() : {};
    if (isRecord(names)) slackNameStore.set(Object.fromEntries(Object.entries(names).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
  } catch {
    // constraint: without the names a conversation still shows, as "DM" or "channel"
  }
}

export function loadSlackNames() {
  if (Date.now() - slackNamesLoad.at < 5 * 60_000) return;
  slackNamesLoad.at = Date.now();
  void fetchSlackNames();
}

export function slackLink(href: string) {
  const m = /^https:\/\/[\w-]+\.slack\.com\/archives\/(\w+)(?:\/p(\d+))?(?:\?(.*))?$/.exec(href);
  const channel = m?.[1];
  if (channel === undefined) return null;
  return { channel, thread: /(^|&)thread_ts=/.test(m?.[3] ?? "") };
}
export function slackLabel(channel: string, names: Record<string, string>) {
  return names[channel] ?? (channel.startsWith("D") ? "DM" : "channel");
}

const decode = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const escapeLabel = (s: string) => s.replaceAll(/[[\]]/g, String.raw`\$&`);
const firstText = (...texts: (string | undefined)[]) => texts.find(hasText);
const isCodeSpan = (i: number) => i % 2 === 1;

function fencedBlock(part: string) {
  return `\n\`\`\`\n${decode(part.slice(3, -3).replaceAll(/^\n|\n$/g, ""))}\n\`\`\`\n`;
}

function mrkdwnOutsideCode(part: string) {
  return slackTokens(part)
    .replaceAll(/(^|[\s(>])\*([^*\n]+?)\*(?=$|[\s).,!?:;])/gm, "$1**$2**")
    .replaceAll(/(^|[\s(>])_([^_\n]+?)_(?=$|[\s).,!?:;])/gm, "$1*$2*")
    .replaceAll(/(^|[\s(>])~([^~\n]+?)~(?=$|[\s).,!?:;])/gm, "$1~~$2~~")
    .replaceAll(SHORTCODE, (all, code: string, tone?: string) => emojiOf(code.toLowerCase(), hasText(tone) ? Number(tone) : undefined) ?? all)
    .replaceAll("&lt;", "\\<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function mrkdwn(text: string) {
  return boxDrawnTablesAsCode(text)
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, i) => {
      if (!isCodeSpan(i)) return mrkdwnOutsideCode(part);
      return part.startsWith("```") ? fencedBlock(part) : decode(part);
    })
    .join("");
}

const slackTokens = (text: string) =>
  text
    .replaceAll(/<@([UW]\w+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `[@${escapeLabel(firstText(name) ?? id)}](slackuser:${id})`)
    .replaceAll(/<#(C\w+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `[#${escapeLabel(firstText(name) ?? "channel")}](slackchan:${id}${hasText(name) ? `/${encodeURIComponent(name)}` : ""})`)
    .replaceAll(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replaceAll(/<!subteam\^\w+(?:\|([^>]*))?>/g, (_, name?: string) => firstText(name) ?? "@group")
    .replaceAll(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => `[${escapeLabel(decode(label))}](${url})`)
    .replaceAll(/<((?:https?|mailto):[^>]+)>/g, "$1");

export const slackSyntax = (text: string) => (text.includes("<") ? text.split(/(```[\s\S]*?```|`[^`\n]+`)/g).map((part, i) => (isCodeSpan(i) ? part : slackTokens(part))).join("") : text);

export const slackPlain = (text: string, names: Record<string, string> = slackNameStore.get()) =>
  text
    .replaceAll(/<@([UW]\w+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `@${firstText(name, names[id]) ?? id}`)
    .replaceAll(/<#(C\w+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => (hasText(name) ? `#${name}` : (names[id] ?? "#channel")))
    .replaceAll(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replaceAll(/<!subteam\^\w+(?:\|([^>]*))?>/g, (_, name?: string) => firstText(name) ?? "@group")
    .replaceAll(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, _url: string, label: string) => decode(label))
    .replaceAll(/<((?:https?|mailto):[^>]+)>/g, "$1");

const BOX_DRAWING = /[\u{2500}-\u{257F}]/u;
function boxDrawnTablesAsCode(text: string) {
  if (!BOX_DRAWING.test(text)) return text;
  let isFenced = false;
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) out.push("```", ...run, "```");
    run = [];
  };
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      isFenced = !isFenced;
      flush();
      out.push(line);
    } else if (!isFenced && BOX_DRAWING.test(line)) run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

export function SlackGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-label="Slack" className={cn("size-3", className)}>
      <path fill="#E01E5A" d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.53h2.52v2.53Zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.31a2.53 2.53 0 1 1-5.05 0v-6.31Z" />
      <path fill="#36C5F0" d="M8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52H8.83Zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05h6.31Z" />
      <path fill="#2EB67D" d="M18.96 8.83a2.53 2.53 0 1 1 2.52 2.53h-2.52V8.83Zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 1 1 5.05 0v6.31Z" />
      <path fill="#ECB22E" d="M15.17 18.96a2.53 2.53 0 1 1-2.53 2.52v-2.52h2.53Zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 0 1 0 5.05h-6.31Z" />
    </svg>
  );
}

export function GitHubGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-label="GitHub" className={cn("size-3", className)}>
      <path
        fill="currentColor"
        d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.82-.26.82-.57v-2c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22v3.29c0 .31.21.69.82.57A12 12 0 0 0 12 .3"
      />
    </svg>
  );
}
