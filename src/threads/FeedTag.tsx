import { Radio } from "lucide-react";
import type { Thread } from "@/mock";

/** Marks a thread maxflow started by itself from his event feed, linking what reached him; he stops it by saying so in the thread. */
export function FeedTag({ feed }: { feed: NonNullable<Thread["feed"]> }) {
  return (
    <a
      href={feed.link}
      target="_blank"
      rel="noreferrer"
      data-agent="feed-tag"
      title={`maxflow took this up by itself, from ${feed.who} (${feed.source}). Say stop in the thread to call it off.`}
      onClick={e => e.stopPropagation()}
      className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 font-medium text-muted-foreground hover:text-foreground"
    >
      <Radio className="size-3" />
      from the feed
    </a>
  );
}
