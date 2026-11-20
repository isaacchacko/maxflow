import { isRecord } from "./shared/guards";
import { peekStateJson, writeStateJson } from "./state";

type SentryPosts = Record<string, { sentry: string; at: number }>;

const POSTS_FILE = "sentry-posts.json";
const COMMENT_ID = /#issuecomment-(\d+)$/;
const KEPT = 2000;

const isSentryPosts = (value: unknown): value is SentryPosts => isRecord(value);
const read = (): SentryPosts => {
  const all = peekStateJson(POSTS_FILE);
  return isSentryPosts(all) ? all : {};
};

export function recordSentryPost(sentry: string, commentId: number) {
  const kept = Object.entries(read()).toSorted(([, a], [, b]) => b.at - a.at).slice(0, KEPT - 1);
  writeStateJson(POSTS_FILE, { ...Object.fromEntries(kept), [String(commentId)]: { sentry, at: Date.now() } });
}

export function sentryThatPosted(commentUrl: string | undefined): string | undefined {
  const id = COMMENT_ID.exec(commentUrl ?? "")?.[1];
  return id === undefined ? undefined : read()[id]?.sentry;
}
