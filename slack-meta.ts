import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcp } from "./mcp";
import { isRecord } from "./shared/guards";
import { peekStateJson, readStateJson, slackMessagesTable, stateDirectory, writeStateJson, type SlackKept } from "./state";

const AVATARS = "avatars";
const AVATAR_INDEX = join(AVATARS, "slack.json");
const DAY = 86_400_000;
const NAMES_KEPT_MS = 60_000;
const FETCH_MS = 30_000;
export const ME = process.env["SLACK_ME"] ?? "U0B33G87YH4";

export function dmPartnersByChannel(): Record<string, unknown> {
  const slackState = peekStateJson("slack-state.json");
  const dms = isRecord(slackState) && isRecord(slackState["dms"]) ? slackState["dms"] : {};
  return Object.fromEntries(Object.entries(dms).map(([id, dm]) => [id, isRecord(dm) ? dm["who"] : undefined]));
}

const dmNamesByChannel = () => Object.fromEntries(Object.entries(dmPartnersByChannel()).map(([id, who]) => [id, `DM with ${String(who)}`]));

type Msgs = SlackKept["msgs"];

const namedUsers = (msgs: Msgs) => msgs.filter((m) => m.uid !== "" && m.who !== "").map((m): [string, string] => [m.uid, m.who]);
const firstNamesOfPeople = (msgs: Msgs) => msgs.filter((m) => m.bot !== true && m.uid !== ME).map((m) => m.who.split(" ", 1)[0] ?? "");

function namesFromStore() {
  const names: Record<string, string> = {};
  const peopleByChannel: Record<string, Set<string>> = {};
  for (const [target, { title, msgs }] of Object.entries(slackMessagesTable.all())) {
    if (target.startsWith("search:")) continue;
    const channel = target.split("/", 1)[0] ?? "";
    const named = /(?:^| in )(#[\w-]+)$/.exec(title)?.[1];
    if (named !== undefined && named !== "") names[channel] ??= named;
    for (const [uid, who] of namedUsers(msgs)) names[uid] ??= who;
    const people = firstNamesOfPeople(msgs);
    if (people.length > 0) peopleByChannel[channel] = new Set([...(peopleByChannel[channel] ?? []), ...people]);
  }
  return { names, peopleByChannel };
}

const cachedNames: { at: number; map: Record<string, string> } = { at: 0, map: {} };
export function slackNames(channels: Record<string, string> = {}) {
  if (Date.now() - cachedNames.at < NAMES_KEPT_MS) return cachedNames.map;
  const { names, peopleByChannel } = namesFromStore();
  const map: Record<string, string> = { ...names, ...channels, ...dmNamesByChannel() };
  for (const [channel, who] of Object.entries(peopleByChannel)) {
    if ((map[channel] ?? "") === "" && channel.startsWith("C")) map[channel] = `group DM with ${[...who].slice(0, 3).join(", ")}`;
  }
  cachedNames.at = Date.now();
  cachedNames.map = map;
  return map;
}

type Avatar = { file?: string; at: number };
type Index = Record<string, Avatar>;
const isAvatar = (value: unknown): value is Avatar => isRecord(value) && typeof value["at"] === "number" && (value["file"] === undefined || typeof value["file"] === "string");
function readIndex(): Index {
  const parsed = readStateJson(AVATAR_INDEX, isRecord);
  return Object.fromEntries(Object.entries(parsed ?? {}).filter((entry): entry is [string, Avatar] => isAvatar(entry[1])));
}

const lookups = new Map<string, Promise<string | undefined>>();
const existingFile = (file: string | undefined) => (file !== undefined && file !== "" && existsSync(file) ? file : undefined);

async function lookUpOnce(user: string, name: string) {
  try {
    return await lookUp(user, name);
  } finally {
    lookups.delete(user);
  }
}

export async function slackAvatar(user: string, name: string): Promise<string | undefined> {
  if (!/^[UW]\w+$/.test(user)) return undefined;
  const hit = readIndex()[user];
  if (hit !== undefined && Date.now() - hit.at < DAY) return existingFile(hit.file);
  const lookup = lookups.get(user) ?? lookUpOnce(user, name);
  lookups.set(user, lookup);
  const staleWhileFetching = existingFile(hit?.file);
  return staleWhileFetching ?? lookup;
}

async function fetchSizedPicture(url: string) {
  // constraint: Slack keeps each picture at fixed sizes beside the original; 192 is sharp at 36px on a retina screen.
  const sized = await fetch(url.replace(/_original\.(\w+)$/, "_192.$1"), { signal: AbortSignal.timeout(FETCH_MS) });
  return sized.ok ? sized : fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
}

async function savedPicture(user: string, name: string): Promise<string | undefined> {
  const out = (await mcp("claude.ai/slack", "slack_search_users", { query: name === "" ? user : name })).out.replaceAll(/\\\\?\//g, "/");
  const resultOfUser = out.split("### Result").find((b) => b.includes(`User ID: ${user}`));
  const url = resultOfUser === undefined ? undefined : /Profile Pic: \[Photo\]\((https:[^)]+)\)/.exec(resultOfUser)?.[1];
  if (url === undefined || url === "") return;
  const res = await fetchSizedPicture(url);
  if (!res.ok) return;
  const file = join(stateDirectory(AVATARS), `slack-${user}.${/\.(\w+)$/.exec(url)?.[1] ?? "jpg"}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function lookUp(user: string, name: string) {
  let file: string | undefined;
  try {
    file = await savedPicture(user, name);
  } catch {
    file = undefined;
  }
  const index = readIndex();
  index[user] = { ...(file !== undefined && { file }), at: Date.now() };
  stateDirectory(AVATARS);
  writeStateJson(AVATAR_INDEX, index);
  return file;
}
