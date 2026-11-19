// What the browser needs to draw Slack as Slack: each conversation's name for a link's chip, and each person's picture.
// Names come from what the slack sentry already read (its DMs, its store, the channels events named); pictures from Slack's user
// search, the one read that carries them, cached on disk by user id and looked up again after a day.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./instance";
import { slackMessagesTable } from "./state";

const AVATARS = join(STATE_DIR, "avatars");
const AVATAR_INDEX = join(AVATARS, "slack.json");
const DAY = 86_400_000;
const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };

// #name for a channel, "DM with X" for a DM, "group DM with X, Y" for a group DM, by channel id; and each person's name by user id.
let names: { at: number; map: Record<string, string> } = { at: 0, map: {} };
export function slackNames(channels: Record<string, string> = {}) {
  if (Date.now() - names.at < 60_000) return names.map;
  const map: Record<string, string> = { ...channels };
  for (const [id, d] of Object.entries(readJson<{ dms?: Record<string, { who: string }> }>(join(STATE_DIR, "slack-state.json"), {}).dms ?? {})) map[id] = `DM with ${d.who}`;
  const store = slackMessagesTable.all();
  const people: Record<string, Set<string>> = {};
  for (const [target, { title, msgs }] of Object.entries(store)) {
    if (target.startsWith("search:")) continue;
    const channel = target.split("/")[0];
    const named = title.match(/(?:^| in )(#[\w-]+)$/)?.[1];
    if (named) map[channel] ??= named;
    for (const m of msgs) {
      // A user's name by their id, for a mention that carries only the id.
      if (m.uid && m.who) map[m.uid] ??= m.who;
      if (!m.bot && m.uid !== ME) (people[channel] ??= new Set()).add(m.who.split(" ")[0]);
    }
  }
  for (const [channel, who] of Object.entries(people)) if (!map[channel] && channel.startsWith("C")) map[channel] = `group DM with ${[...who].slice(0, 3).join(", ")}`;
  names = { at: Date.now(), map };
  return map;
}
export const ME = process.env.SLACK_ME ?? "U0B33G87YH4";

type Index = Record<string, { file?: string; at: number }>;
const lookups = new Map<string, Promise<string | undefined>>();
// The file holding a Slack user's picture, fetched on first ask and again a day later; undefined when Slack has none for them.
export function slackAvatar(user: string, name: string) {
  if (!/^[UW]\w+$/.test(user)) return Promise.resolve(undefined);
  const index = readJson<Index>(AVATAR_INDEX, {});
  const hit = index[user];
  if (hit && Date.now() - hit.at < DAY) return Promise.resolve(hit.file && existsSync(hit.file) ? hit.file : undefined);
  if (!lookups.has(user))
    lookups.set(user, lookUp(user, name).finally(() => lookups.delete(user)));
  // A stale picture is served while the new one is fetched.
  return hit?.file && existsSync(hit.file) ? Promise.resolve(hit.file) : lookups.get(user)!;
}

async function lookUp(user: string, name: string) {
  let file: string | undefined;
  try {
    const proc = Bun.spawn(["mcp", "--json", "--timeout", "60", "call", "claude.ai/slack", "slack_search_users", JSON.stringify({ query: name || user })], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).replace(/\\\\?\//g, "/");
    // Each result is a block; the one with this user's id carries the picture.
    const block = out.split(/### Result/).find((b) => b.includes(`User ID: ${user}`));
    const url = block?.match(/Profile Pic: \[Photo\]\((https:[^)]+)\)/)?.[1];
    if (url) {
      // Slack keeps the same picture at fixed sizes beside the original; 192 is sharp at 36px on a retina screen.
      const res = await fetch(url.replace(/_original\.(\w+)$/, "_192.$1")).then((r) => (r.ok ? r : fetch(url)));
      if (res.ok) {
        mkdirSync(AVATARS, { recursive: true });
        file = join(AVATARS, `slack-${user}.${url.match(/\.(\w+)$/)?.[1] ?? "jpg"}`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      }
    }
  } catch {}
  const index = readJson<Index>(AVATAR_INDEX, {});
  index[user] = { ...(file && { file }), at: Date.now() };
  mkdirSync(AVATARS, { recursive: true });
  writeFileSync(AVATAR_INDEX, JSON.stringify(index));
  return file;
}
