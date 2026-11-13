import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, History, MessageCircleQuestion, Network, PanelLeft, Plus, SquareKanban, TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { displayName, isBusy, isSentry, isWaiting, kindOf, type Session, type View } from "@/lib/api";
import { cn } from "@/lib/utils";

function Tip({ label, keys, side = "bottom", children }: { label: string; keys?: string; side?: "bottom" | "right"; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-2">
        {label}
        {keys && <Kbd>{keys}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

export function StatusDot({ s, className }: { s: Session; className?: string }) {
  const busy = isBusy(s), waiting = isWaiting(s);
  return (
    <span
      title={!s.running ? `exited ${s.exitCode ?? "?"}` : busy ? "working" : waiting ? "waiting on you" : kindOf(s)}
      className={cn(
        "size-2 shrink-0 rounded-full",
        !s.running ? "bg-muted-foreground/40" : isSentry(s) ? "bg-sentry" : busy ? "bg-busy animate-pulse" : waiting ? "bg-waiting animate-pulse" : s.agent ? "bg-chat" : "bg-foreground/70",
        className,
      )}
    />
  );
}

function Row({ s, active, collapsed, onOpen, onKill, onArchive, onRename }: {
  s: Session;
  active: boolean;
  collapsed: boolean;
  onOpen: () => void;
  onKill: () => void;
  onArchive: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const finish = (save: boolean) => {
    const name = input.current?.value.trim();
    setEditing(false);
    if (save && name && name !== s.name) onRename(name);
  };

  if (collapsed)
    return (
      <Tip label={displayName(s)} side="right">
        <button onClick={onOpen} className={cn("flex h-8 w-full items-center justify-center rounded-md hover:bg-accent", active && "bg-accent", s.archived && "opacity-50")}>
          <StatusDot s={s} />
        </button>
      </Tip>
    );

  return (
    <div
      onClick={onOpen}
      title={`${s.name}\n${s.cmd.join(" ")}\n${s.cwd}`}
      className={cn("group relative flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 hover:bg-accent/60", active && "bg-accent")}
    >
      <StatusDot s={s} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={input}
            defaultValue={s.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => finish(true)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && (e.preventDefault(), finish(e.key === "Enter"))}
            className="w-full rounded-sm bg-background px-1 text-sm outline-none ring-1 ring-ring"
          />
        ) : (
          <div onDoubleClick={(e) => (e.stopPropagation(), setEditing(true))} className={cn("truncate text-sm", (!s.running || s.archived) && "text-muted-foreground")}>
            {displayName(s)}
          </div>
        )}
      </div>
      <div className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 gap-1 group-hover:flex">
        {!isSentry(s) && (
          <button
            title={s.archived ? "Unarchive" : "Archive"}
            onClick={(e) => (e.stopPropagation(), onArchive())}
            className="flex size-6 items-center justify-center rounded-md border bg-popover text-muted-foreground shadow-sm hover:text-foreground"
          >
            {s.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </button>
        )}
        <button
          title="Kill session"
          onClick={(e) => (e.stopPropagation(), onKill())}
          className="flex size-6 items-center justify-center rounded-md border bg-popover text-muted-foreground shadow-sm hover:text-destructive"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

type Props = {
  sessions: Session[];
  current: string | null;
  collapsed: boolean;
  view: View;
  onToggle: () => void;
  onView: (v: View) => void;
  onResume: () => void;
  questions: number;
  onQuestions: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onKill: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  hideArchived: boolean;
  onToggleArchived: () => void;
  onRename: (id: string, name: string) => void;
};

const VIEWS = [
  { view: "agent", label: "Agent", keys: undefined, Icon: TerminalSquare },
  { view: "graph", label: "Graph", keys: "⌘G", Icon: Network },
  { view: "tasks", label: "Board", keys: "⌘K", Icon: SquareKanban },
] as const;

export function Sidebar({ sessions, current, collapsed, view, onToggle, onView, onResume, questions, onQuestions, onNew, onOpen, onKill, onArchive, hideArchived, onToggleArchived, onRename }: Props) {
  const byActivity = [...sessions].sort((a, b) => b.activeAt - a.activeAt);
  const agents = byActivity.filter((s) => !isSentry(s) && !s.archived), sentries = sessions.filter(isSentry);
  const archived = byActivity.filter((s) => !isSentry(s) && s.archived);
  const rows = (list: Session[]) =>
    list.map((s) => (
      <Row key={s.id} s={s} active={s.id === current} collapsed={collapsed} onOpen={() => onOpen(s.id)} onKill={() => onKill(s.id)} onArchive={() => onArchive(s.id, !s.archived)} onRename={(n) => onRename(s.id, n)} />
    ));

  return (
    <aside className="flex min-h-0 flex-col border-r bg-sidebar max-sm:max-h-[35vh] max-sm:border-r-0 max-sm:border-b">
      <header className={cn("flex h-12 shrink-0 items-center gap-1 border-b px-2", collapsed && "justify-center")}>
        <Tip label="Toggle sidebar" keys="⌘B" side={collapsed ? "right" : "bottom"}>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground max-sm:hidden" onClick={onToggle}>
            <PanelLeft />
          </Button>
        </Tip>
        {!collapsed && (
          <>
            <span className="ml-1 text-sm font-semibold tracking-tight">maxflow</span>
            {agents.length > 0 && <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[11px]">{agents.length}</Badge>}
            <div className="ml-auto flex items-center gap-0.5">
              <Tip label="Questions agents asked you">
                <Button variant="ghost" size="icon" className={cn("relative size-8 text-muted-foreground", questions > 0 && "text-sentry")} onClick={onQuestions}>
                  <MessageCircleQuestion />
                  {questions > 0 && <span className="absolute -top-0.5 -right-0.5 rounded-full bg-sentry px-1 font-mono text-[10px] leading-4 text-background">{questions}</span>}
                </Button>
              </Tip>
              <Tip label="Resume a Claude chat">
                <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={onResume}>
                  <History />
                </Button>
              </Tip>
              <Tip label="New shell" keys="⌃T">
                <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={onNew}>
                  <Plus />
                </Button>
              </Tip>
            </div>
          </>
        )}
      </header>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        spacing={collapsed ? 1 : 0}
        value={view}
        onValueChange={(v) => v && onView(v as View)}
        className={cn("mx-2 mt-2 shrink-0", collapsed ? "flex-col self-center" : "w-auto")}
      >
        {VIEWS.map(({ view: v, label, keys, Icon }) => (
          <Tip key={v} label={`${label} view`} keys={keys} side={collapsed ? "right" : "bottom"}>
            <ToggleGroupItem value={v} aria-label={label} className={cn("text-muted-foreground aria-checked:bg-accent aria-checked:text-foreground", collapsed ? "size-8 px-0" : "flex-1 text-xs")}>
              <Icon />
              {!collapsed && label}
            </ToggleGroupItem>
          </Tip>
        ))}
      </ToggleGroup>
      <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
        <div className="flex flex-col gap-0.5 p-1.5">{rows(agents)}</div>
        {archived.length > 0 && (
          <div className="flex flex-col gap-0.5 p-1.5 pt-0">
            {!collapsed && (
              <button onClick={onToggleArchived} className="flex items-center px-2.5 pt-1 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase hover:text-foreground">
                Archived · {archived.length}
                <span className="ml-auto normal-case tracking-normal">{hideArchived ? "show" : "hide"}</span>
              </button>
            )}
            {!hideArchived && rows(archived)}
          </div>
        )}
      </ScrollArea>
      {sentries.length > 0 && (
        <div className="shrink-0 border-t p-1.5">
          {!collapsed && <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Sentries</div>}
          <div className="flex flex-col gap-0.5">{rows(sentries)}</div>
        </div>
      )}
    </aside>
  );
}
