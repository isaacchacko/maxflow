import { channelIdByName, replyField, slackCall } from "../slack-read";

export type DmConversation = { who: string; at: number };

const isDisplayNameOf = (displayName: string, member: string) => member === displayName || member.startsWith(`${displayName} `);

export function groupDmNamed(subtitle: string, groups: Record<string, string[]>) {
  const names = subtitle.split(", ");
  const group = Object.entries(groups).find(([, members]) => members.length === names.length && names.every((n) => members.some((m) => isDisplayNameOf(n, m))));
  return group?.[0] ?? null;
}

async function dmWithPerson(name: string) {
  const users = replyField(await slackCall("slack_search_users", { keywords: name.split(/\s+/), limit: 5 }), "results");
  const uid = users.matchAll(/Name: (.*?)\n[\s\S]*?User ID: (\w+)/g).find((m) => (m[1] ?? "").trim() === name)?.[2];
  if (uid === undefined) return null;
  const messages = replyField(await slackCall("slack_read_channel", { channel_id: uid, limit: 1 }), "messages");
  return /^Channel: DM \((D\w+)\)/.exec(messages)?.[1] ?? null;
}

export async function lookUpPlace(subtitle: string, dms: Record<string, DmConversation>): Promise<string | null> {
  const known = Object.entries(dms).find(([, d]) => d.who === subtitle)?.[0];
  if (known !== undefined) return known;
  const channel = await channelIdByName(subtitle.replace(/^#/, ""), 5);
  if (channel !== undefined) return channel;
  if (subtitle.startsWith("#")) return null;
  return dmWithPerson(subtitle);
}
