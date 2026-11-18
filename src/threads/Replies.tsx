import type { Thread } from "@/mock";
import { agentStore, threadStore } from "@/store";
import { Avatar } from "./Rich";
import { unseenDeep, useSeen } from "./seen";
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
  useSeen();
  const replies = repliesOf(t);
  const fresh = unseenDeep(t, all);
  const faces = [...new Set(replies.map(m => m.from).reverse())].slice(0, 4);
  return (
    <a href={`#thread/${t.id}`} data-agent={`inbox:${t.id}`} className="mt-1 -ml-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-full border border-transparent py-0.5 pr-2.5 pl-1 text-xs whitespace-nowrap hover:border-border hover:bg-card">
      {faces.length > 0 && (
        <span className="flex shrink-0 gap-0.5">
          {faces.map(f => (
            <Avatar key={f} from={f} small />
          ))}
        </span>
      )}
      {replies.length > 0 ? <span className="shrink-0 font-semibold text-link">{replies.length === 1 ? "1 reply" : `${replies.length} replies`}</span> : !t.pending && <span className="text-muted-foreground">No replies yet</span>}
      {fresh > 0 && <span className="shrink-0 rounded-full bg-new-soft px-1.5 font-medium text-new">{fresh} new</span>}
      {t.pending ? (
        <Pending pending={t.pending} names={t.pending.routerIds.map(rid => agents.find(a => a.id === rid)?.name ?? rid)} />
      ) : (
        replies.length > 0 && <span className="shrink-0 text-muted-foreground">Last reply {ago(Date.parse(replies.at(-1)!.at))} ago</span>
      )}
    </a>
  );
}
