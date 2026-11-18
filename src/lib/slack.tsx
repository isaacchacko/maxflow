import { createStore } from "@/store";
import { emojiOf, SHORTCODE } from "./emoji";
import { cn } from "./utils";

/** Each Slack conversation's name by channel id ("#festo", "DM with Christoph Moser", "group DM with …"), from the server. */
export const slackNameStore = createStore<Record<string, string>>({});
let loadedAt = 0;
export function loadSlackNames() {
  if (Date.now() - loadedAt < 5 * 60_000) return;
  loadedAt = Date.now();
  fetch("/api/slack/names").then(r => (r.ok ? r.json() : {})).then(names => slackNameStore.set(names), () => {});
}

/** A Slack permalink's conversation and whether it points into a thread. */
export function slackLink(href: string) {
  const m = href.match(/^https:\/\/[\w-]+\.slack\.com\/archives\/(\w+)(?:\/p(\d+))?(?:\?(.*))?$/);
  if (!m) return null;
  return { channel: m[1]!, thread: /(^|&)thread_ts=/.test(m[3] ?? "") };
}
export function slackLabel(channel: string, names: Record<string, string>) {
  return names[channel] ?? (channel.startsWith("D") ? "DM" : "channel");
}

// The shortcodes people actually use, as the character Slack shows; any other stays as typed.
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escapeLabel = (s: string) => s.replace(/[[\]]/g, "\\$&");

/**
 * Slack's mrkdwn as the markdown the rest of the app draws: mentions and channels become chips (slackuser:/slackchan: links),
 * <url|label> a link, *bold* / _italic_ / ~strike~ their markdown, :shortcodes: their emoji. Code, inline or fenced, is kept as
 * written; a fence Slack ran onto one line gets lines of its own.
 */
export function mrkdwn(text: string) {
  return boxesAsCode(text)
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2) return part.startsWith("```") ? `\n\`\`\`\n${decode(part.slice(3, -3).replace(/^\n|\n$/g, ""))}\n\`\`\`\n` : decode(part);
      return part
        .replace(/<@(\w+)(?:\|([^>]*))?>/g, (_, id, name) => `[@${escapeLabel(name || id)}](slackuser:${id})`)
        .replace(/<#(\w+)(?:\|([^>]*))?>/g, (_, id, name) => `[#${escapeLabel(name || "channel")}](slackchan:${id}${name ? `/${encodeURIComponent(name)}` : ""})`)
        .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
        .replace(/<!subteam\^\w+(?:\|([^>]*))?>/g, (_, name) => name || "@group")
        .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url, label) => `[${escapeLabel(decode(label))}](${url})`)
        .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
        .replace(/(^|[\s(>])\*([^*\n]+?)\*(?=$|[\s).,!?:;])/gm, "$1**$2**")
        .replace(/(^|[\s(>])_([^_\n]+?)_(?=$|[\s).,!?:;])/gm, "$1*$2*")
        .replace(/(^|[\s(>])~([^~\n]+?)~(?=$|[\s).,!?:;])/gm, "$1~~$2~~")
        .replace(SHORTCODE, (all, code: string, tone?: string) => emojiOf(code.toLowerCase(), tone ? Number(tone) : undefined) ?? all)
        .replace(/&lt;/g, "\\<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    })
    .join("");
}

// A table drawn with box characters (┌─┬─┐ │ ├─┼─┤) only lines up in a fixed-width font, and wrapped it is a wall of rules: its lines
// become a code block, which keeps them whole and scrolls sideways.
const BOX = /[\u2500-\u257F]/;
function boxesAsCode(text: string) {
  if (!BOX.test(text)) return text;
  let fenced = false;
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => (run.length && out.push("```", ...run, "```"), (run = []));
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) (fenced = !fenced), flush(), out.push(line);
    else if (!fenced && BOX.test(line)) run.push(line);
    else flush(), out.push(line);
  }
  flush();
  return out.join("\n");
}

/** Slack's mark, in its four colours. */
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

/** GitHub's mark, in the text colour. */
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
