import type { Thread } from "@/mock";
import { agentStore, threadStore } from "@/store";
import { hasText } from "@/lib/utils";
import { Avatar } from "./Rich";
import { unseenDeep, useSeen } from "./seen";
import { Pending } from "./ThreadPage";

export function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const repliesOf = (t: Thread) => (hasText(t.parentId) ? t.messages : t.messages.slice(1));

export function Replies({ t }: { t: Thread }) {
  const agents = agentStore.use();
  const all = threadStore.use();
  useSeen();
  const replies = repliesOf(t);
  const fresh = unseenDeep(t, all);
  const lastReply = replies.at(-1);
  const faces = [...new Set(replies.map(m => m.from).toReversed())].slice(0, 4);
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
        <Pending inline pending={t.pending} names={t.pending.routerIds.map(rid => agents.find(a => a.id === rid)?.name ?? rid)} />
      ) : (
        lastReply && <span className="shrink-0 text-muted-foreground">Last reply {ago(Date.parse(lastReply.at))} ago</span>
      )}
    </a>
  );
}
