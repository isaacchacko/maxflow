import { cn } from "@/lib/utils";
import { NOW_AT } from "@/mock";
import { Author, Avatar, ExtAuthor, ExtAvatar, type External, Markdown, SlackChip } from "./Rich";

export function when(at: string) {
  return at.slice(0, 10) === NOW_AT.slice(0, 10)
    ? at.slice(11, 16)
    : new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * One message as Slack draws it: picture, bold name and time, then the body. Grouped under the sender's previous message,
 * it drops the picture and name and shows its time in the gutter on hover. `meta` sits after the time, `children` under the body.
 * A message the feed posted for someone on Slack or
 * GitHub (`ext`) is theirs: their picture and name, where it was said, and Slack's mrkdwn drawn as Slack draws it; one from before
 * the new ones in its conversation is muted and labelled context.
 */
export function MessageRow({ from, at, text, ext, where = true, grouped, meta, children, className, bodyClassName, onClick }: { from: string; at: string; text: string; ext?: External; where?: boolean; grouped?: boolean; meta?: React.ReactNode; children?: React.ReactNode; className?: string; bodyClassName?: string; onClick?: (e: React.MouseEvent) => void }) {
  // A line maxflow writes itself (a router handing the thread to another): small and muted, not anyone's message.
  if (from === "maxflow")
    return (
      <article data-from={from} data-at={at} className={cn("-mx-5 flex items-baseline gap-2 px-5 py-1 text-xs text-muted-foreground", className)}>
        <span className="w-9 shrink-0 text-right text-[10px] tabular-nums">{at.slice(11, 16)}</span>
        <Markdown text={text} className="min-w-0 flex-1 text-xs" />
      </article>
    );
  return (
    <article onClick={onClick} data-from={from} data-at={at} data-context={ext?.context || undefined} className={cn("group -mx-5 flex gap-2 px-5 py-2 hover:bg-muted/50", ext?.context && "opacity-60", className)}>
      {grouped ? (
        <span className="invisible w-9 shrink-0 pt-0.5 text-right text-[10px] text-muted-foreground tabular-nums group-hover:visible">{at.slice(11, 16)}</span>
      ) : ext ? (
        <ExtAvatar ext={ext} />
      ) : (
        <Avatar from={from} />
      )}
      <div className="min-w-0 flex-1">
        {!grouped && (
          // One line: the name ends in an ellipsis only once what follows the time has given all it can, and the time never breaks.
          <div className="flex min-w-0 items-baseline gap-2 whitespace-nowrap group-hover/bar:pr-[calc(var(--bar-w,0px)_-_1.25rem)]">
            {ext ? <ExtAuthor ext={ext} className="min-w-0 truncate" /> : <Author from={from} className="min-w-0 truncate" />}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{when(at)}</span>
            {ext?.context && <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground uppercase">context</span>}
            {ext && where && !meta && ext.source === "slack" && <span className="min-w-0 text-xs"><SlackChip href={ext.link} /></span>}
            {meta && <span className="flex min-w-0 flex-1 basis-0 items-baseline [&>*]:min-w-0">{meta}</span>}
          </div>
        )}
        <Markdown text={text} slack={ext?.source === "slack"} className={cn("text-sm leading-relaxed", bodyClassName)} />
        {children}
      </div>
    </article>
  );
}
