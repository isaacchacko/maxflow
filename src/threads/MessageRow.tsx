import { cn } from "@/lib/utils";
import { NOW_AT } from "@/mock";
import { Author, Avatar, ExtAuthor, ExtAvatar, type External, Markdown, SlackChip } from "./Rich";

export function when(at: string) {
  return at.slice(0, 10) === NOW_AT.slice(0, 10)
    ? at.slice(11, 16)
    : new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const ALARM = "⚠";
function MaxflowNote({ at, text, className }: { at: string; text: string; className?: string | undefined }) {
  return (
    <article data-from="maxflow" data-at={at} data-alarm={text.startsWith(ALARM) || undefined} className={cn("-mx-5 flex items-baseline gap-2 px-5 py-1 text-xs text-muted-foreground", text.startsWith(ALARM) && "border-l-2 border-destructive bg-destructive/5 py-2 text-sm font-medium text-destructive", className)}>
      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums">{at.slice(11, 16)}</span>
      <Markdown text={text} className={cn("min-w-0 flex-1", text.startsWith(ALARM) ? "text-sm" : "text-xs")} />
    </article>
  );
}

function Gutter({ from, at, ext, grouped }: { from: string; at: string; ext: External | undefined; grouped: boolean }) {
  if (grouped) return <span className="invisible w-9 shrink-0 pt-0.5 text-right text-[10px] text-muted-foreground tabular-nums group-hover:visible">{at.slice(11, 16)}</span>;
  return ext ? <ExtAvatar ext={ext} /> : <Avatar from={from} />;
}

function Header({ from, at, ext, where, meta }: { from: string; at: string; ext: External | undefined; where: boolean; meta: React.ReactNode }) {
  const hasMeta = Boolean(meta);
  const isSlackChipShown = ext !== undefined && where && !hasMeta && ext.source === "slack";
  return (
    <div className="flex min-w-0 items-baseline gap-2 whitespace-nowrap group-hover/bar:pr-[calc(var(--bar-w,0px)_-_1.25rem)]">
      {ext ? <ExtAuthor ext={ext} className="min-w-0 truncate" /> : <Author from={from} className="min-w-0 truncate" />}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{when(at)}</span>
      {ext?.context === true && <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground uppercase">context</span>}
      {isSlackChipShown && <span className="min-w-0 text-xs"><SlackChip href={ext.link} /></span>}
      {hasMeta && <span className="flex min-w-0 flex-1 basis-0 items-baseline [&>*]:min-w-0">{meta}</span>}
    </div>
  );
}

export function MessageRow({ from, at, text, ext, where = true, grouped = false, meta, children, className, bodyClassName, onClick }: { from: string; at: string; text: string; ext?: External | undefined; where?: boolean; grouped?: boolean; meta?: React.ReactNode; children?: React.ReactNode; className?: string; bodyClassName?: string; onClick?: (e: React.MouseEvent) => void }) {
  if (from === "maxflow") return <MaxflowNote at={at} text={text} className={className} />;
  const isContext = ext?.context === true;
  return (
    <article onClick={onClick} data-from={from} data-at={at} data-context={isContext ? true : undefined} className={cn("group -mx-5 flex gap-2 px-5 py-2 hover:bg-muted/50", isContext && "opacity-60", className)}>
      <Gutter from={from} at={at} ext={ext} grouped={grouped} />
      <div className="min-w-0 flex-1">
        {!grouped && <Header from={from} at={at} ext={ext} where={where} meta={meta} />}
        <Markdown text={text} slack={ext?.source === "slack"} className={cn("text-sm leading-relaxed", bodyClassName)} />
        {children}
      </div>
    </article>
  );
}
