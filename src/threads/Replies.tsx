import type { Thread } from "@/mock";
import { agentStore, threadStore } from "@/store";
import { Avatar } from "./Rich";
import { unseenDeep } from "./seen";
import { Pending } from "./ThreadPage";

export function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}

/** A top thread's first message is its root; a subthread's root is in its parent, so all its messages are replies. */
export const repliesOf = (t: Thread) => (t.parentId ? t.messages : t.messages.slice(1));

/** Under a message, as Slack does: who replied, how many, how many he hasn't seen down the tree, and when last; or the router still working on it. */
export function Replies({ t }: { t: Thread }) {
  const agents = agentStore.use();
  const all = threadStore.use();
  const replies = repliesOf(t);
  const fresh = unseenDeep(t, all);
  const faces = [...new Set(replies.map(m => m.from).reverse())].slice(0, 4);
  return (
    <a href={`#thread/${t.id}`} data-agent={`inbox:${t.id}`} className="mt-1 flex w-fit max-w-full items-center gap-2 border whitespace-nowrap border-transparent py-0.5 pr-2 text-xs hover:border-border hover:bg-background">
      {faces.length > 0 && (
        <span className="flex gap-0.5">
          {faces.map(f => (
            <Avatar key={f} from={f} small />
          ))}
        </span>
      )}
      {replies.length > 0 ? <span className="font-semibold text-sky-400">{replies.length === 1 ? "1 reply" : `${replies.length} replies`}</span> : !t.pending && <span className="text-muted-foreground">No replies yet</span>}
      {fresh > 0 && <span className="bg-rose-500/15 px-1 font-medium text-rose-400">{fresh} new</span>}
      {t.pending ? (
        <Pending pending={t.pending} names={t.pending.routerIds.map(rid => agents.find(a => a.id === rid)?.name ?? rid)} />
      ) : (
        replies.length > 0 && <span className="text-muted-foreground">Last reply {ago(Date.parse(replies.at(-1)!.at))} ago</span>
      )}
    </a>
  );
}
