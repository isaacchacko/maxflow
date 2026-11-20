import { isRecord } from "../shared/guards";
import { shortened, stringField } from "./inbox-board";

export type BoardConfig = {
  url: string;
  tokenCommand?: string[];
  cli: string[];
  profile: string;
  self: string[];
  objective: string;
  name: string;
  restartMs: number;
};

export type BoardEvent = {
  cursor: string;
  type: string;
  at: string;
  id: string;
  channel: string;
  thread: string;
  re: string | undefined;
  text: string;
  labels: Record<string, string>;
  who: string;
  name: string;
  kind: string;
};

const DEFAULT_RESTART_MS = 30 * 60_000;
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : undefined);

export function boardConfigOf(value: unknown): BoardConfig | undefined {
  if (!isRecord(value)) return undefined;
  const url = stringField(value, "url");
  if (url === undefined || url === "") return undefined;
  const profile = stringField(value, "profile") ?? "claude";
  const restartMs = value["restartMs"];
  const tokenCommand = strings(value["tokenCommand"]);
  return {
    url,
    ...(tokenCommand !== undefined && { tokenCommand }),
    cli: strings(value["cli"]) ?? ["npx", "-y", "vercel@latest", "board"],
    profile,
    self: strings(value["self"]) ?? [],
    objective: stringField(value, "objective") ?? "",
    name: stringField(value, "name") ?? "the agent board",
    restartMs: typeof restartMs === "number" && restartMs > 0 ? restartMs : DEFAULT_RESTART_MS,
  };
}

const labelsOf = (value: unknown): Record<string, string> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : []))) : {};

export function boardEventOf(line: string): BoardEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const cursor = stringField(parsed, "cursor");
  const type = stringField(parsed, "type");
  if (cursor === undefined || cursor === "" || type === undefined) return undefined;
  const payload = isRecord(parsed["payload"]) ? parsed["payload"] : {};
  const message = isRecord(parsed["message"]) ? parsed["message"] : {};
  const actor = isRecord(parsed["actor"]) ? parsed["actor"] : {};
  return {
    cursor,
    type,
    at: stringField(parsed, "createdAt") ?? "",
    id: stringField(message, "id") ?? stringField(payload, "id") ?? "",
    channel: stringField(payload, "channel") ?? stringField(message, "channel") ?? "",
    thread: stringField(payload, "thread") ?? stringField(message, "thread") ?? "",
    re: stringField(payload, "re"),
    text: stringField(payload, "text") ?? stringField(message, "text") ?? "",
    labels: labelsOf(payload["labels"] ?? message["labels"]),
    who: stringField(actor, "handle") ?? stringField(actor, "id") ?? "?",
    name: stringField(actor, "name") ?? "?",
    kind: stringField(actor, "kind") ?? "",
  };
}

export const isOwn = (event: BoardEvent, config: BoardConfig) => config.self.includes(event.who);
export const isFed = (event: BoardEvent, config: BoardConfig) => event.type === "message.posted" && event.id !== "" && !isOwn(event, config);

const HANDED_LABELS = ["priority", "ticket", "kind", "assignee"];
export const isForIsaac = (event: BoardEvent) => HANDED_LABELS.some((k) => k in event.labels) || /\bisaac\b/i.test(event.text);

export const boardLink = (event: BoardEvent) => `board:${event.channel}/${event.id}`;
export const busTopic = (event: BoardEvent) => `board/${event.channel.replaceAll(/[^\w-]/g, "_") || "_"}/${event.type}`;

export function busData(event: BoardEvent, config: BoardConfig) {
  return { ...event, link: boardLink(event), own: isOwn(event, config) };
}

const labelText = (labels: Record<string, string>) => {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  return pairs.length === 0 ? "" : ` [${pairs.join(", ")}]`;
};

function routingHint(event: BoardEvent, config: BoardConfig) {
  const owner = config.objective === "" ? "" : ` objective ${config.objective}, which owns ${config.name}`;
  if (isForIsaac(event)) return `It hands something to Isaac or his agent: size it like any feed item (a ticket or bug is usually its own work).${owner === "" ? "" : ` Anything about the board itself goes to${owner}.`}`;
  return owner === "" ? "Routine board chatter: size it like any feed item." : `Routine board chatter: size it area and route it to${owner}, unless it plainly belongs elsewhere.`;
}

export function feedText(event: BoardEvent, config: BoardConfig) {
  const cli = `${config.cli.join(" ")}`;
  return [
    `${event.who} (${event.name}) on ${config.name}, #${event.channel}${labelText(event.labels)}:`,
    `> ${event.text.replaceAll("\n", "\n> ")}`,
    boardLink(event),
    `[board] message ${event.id} in thread ${event.thread}${event.re === undefined ? "" : `, a reply to ${event.re}`}. Read the thread with \`${cli} read ${event.id}\` (BOARD_URL=${config.url}); answer on the board as ${config.profile} with \`${cli} reply ${event.id} '<text>' --as ${config.profile}\`.`,
    routingHint(event, config),
  ].join("\n");
}

export const feedTitle = (event: BoardEvent) => `${event.who} on the board: ${shortened(event.text, 70)}`;
