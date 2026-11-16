import { cn } from "@/lib/utils";
import { NOW_AT } from "@/mock";
import { Author, Avatar, Markdown } from "./Rich";

export function when(at: string) {
  return at.slice(0, 10) === NOW_AT.slice(0, 10)
    ? at.slice(11, 16)
    : new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * One message as Slack draws it: picture, bold name and time, then the body. Grouped under the sender's previous message,
 * it drops the picture and name and shows its time in the gutter on hover. `meta` sits after the time, `children` under the body.
 * The keyboard cursor (`active`) draws as the hover band with a bar on its left.
 */
export function MessageRow({ from, at, text, grouped, active, meta, children, className, bodyClassName, onClick }: { from: string; at: string; text: string; grouped?: boolean; active?: boolean; meta?: React.ReactNode; children?: React.ReactNode; className?: string; bodyClassName?: string; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <article onClick={onClick} data-from={from} data-at={at} className={cn("group -mx-2 flex gap-2.5 px-2 py-1 hover:bg-muted/40", active && "bg-muted/40 shadow-[inset_2px_0_0_var(--color-sky-400)]", className)}>
      {grouped ? <span className="invisible w-9 shrink-0 pt-0.5 text-right text-[10px] text-muted-foreground tabular-nums group-hover:visible">{at.slice(11, 16)}</span> : <Avatar from={from} />}
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <Author from={from} />
            <span className="text-xs text-muted-foreground tabular-nums">{when(at)}</span>
            {meta}
          </div>
        )}
        <Markdown text={text} className={cn("text-sm leading-relaxed", bodyClassName)} />
        {children}
      </div>
    </article>
  );
}
