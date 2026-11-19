import type { Feed, FeedPost } from "./model";
import { isRecord } from "./shared/guards";
import { textOf } from "./route-kit";

type External = FeedPost["ext"];
const SOURCES = ["slack", "github"] as const;

function externalOf(value: unknown): External | undefined {
  if (!isRecord(value)) return undefined;
  const source = SOURCES.find((s) => s === value["source"]);
  const [name, link, user, where] = ["name", "link", "user", "where"].map((key) => textOf(value, key));
  if (source === undefined || name === undefined || link === undefined) return undefined;
  return {
    source,
    name,
    ...(user !== undefined && { user }),
    link,
    ...(where !== undefined && { where }),
    ...(value["context"] === true && { context: true }),
    ...(value["own"] === true && { own: true }),
  };
}

function feedPostOf(value: unknown): FeedPost[] {
  if (!isRecord(value)) return [];
  const text = textOf(value, "text");
  const at = value["at"];
  const ext = externalOf(value["ext"]);
  if (text === undefined || ext === undefined) return [];
  return [{ text, ...(typeof at === "number" && { at }), ext }];
}

export const feedPostsOf = (value: unknown): FeedPost[] | undefined => (Array.isArray(value) ? value.flatMap(feedPostOf) : undefined);

export function feedOf(value: unknown): Feed | undefined {
  if (!isRecord(value)) return undefined;
  const [source, who, link] = ["source", "who", "link"].map((key) => textOf(value, key));
  if (source === undefined || who === undefined || link === undefined) return undefined;
  const task = value["task"];
  return { source, who, link, ...(typeof task === "number" && { task }) };
}
