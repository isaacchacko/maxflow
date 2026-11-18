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
 * The keyboard cursor (`active`) draws as the hover band with a bar on its left. A message the feed posted for someone on Slack or
 * GitHub (`ext`) is theirs: their picture and name, where it was said, and Slack's mrkdwn drawn as Slack draws it; one from before
 * the new ones in its conversation is muted and labelled context.
 */
export function MessageRow({ from, at, text, ext, where = true, grouped, active, meta, children, className, bodyClassName, onClick }: { from: string; at: string; text: string; ext?: External; where?: boolean; grouped?: boolean; active?: boolean; meta?: React.ReactNode; children?: React.ReactNode; className?: string; bodyClassName?: string; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <article onClick={onClick} data-from={from} data-at={at} data-context={ext?.context || undefined} className={cn("group -mx-2 flex gap-2.5 rounded-lg px-2 py-1 hover:bg-muted/50", active && "bg-muted/60 shadow-[inset_2px_0_0_var(--color-link)]", ext?.context && "opacity-60", className)}>
      {grouped ? <span className="invisible w-9 shrink-0 pt-0.5 text-right text-[10px] text-muted-foreground tabular-nums group-hover:visible">{at.slice(11, 16)}</span> : ext ? <ExtAvatar ext={ext} /> : <Avatar from={from} />}
      <div className="min-w-0 flex-1">
        {!grouped && (
          // One line: the name ends in an ellipsis only once what follows the time has given all it can, and the time never breaks.
          <div className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
            {ext ? <ExtAuthor ext={ext} className="min-w-0 truncate" /> : <Author from={from} className="min-w-0 truncate" />}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{when(at)}</span>
            {ext?.context && <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground uppercase">context</span>}
            {ext && where && !meta && ext.source === "slack" && <span className="min-w-0 text-xs"><SlackChip href={ext.link} /></span>}
            {meta && <span className="flex min-w-0 flex-1 basis-0 items-baseline [&>*]:min-w-0">{meta}</span>}
          </div>
        )}
        <Markdown text={text} slack={ext?.source === "slack"} className={cn("max-w-[80ch] text-sm leading-relaxed", bodyClassName)} />
        {children}
      </div>
    </article>
  );
}
