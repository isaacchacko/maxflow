import { useEffect, useRef, useState } from "react";
import { History, Network, PanelLeft, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { displayName, isBusy, isSentry, isWaiting, kindOf, type Session } from "@/lib/api";
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

function Row({ s, active, collapsed, onOpen, onKill, onRename }: { s: Session; active: boolean; collapsed: boolean; onOpen: () => void; onKill: () => void; onRename: (name: string) => void }) {
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
        <button onClick={onOpen} className={cn("flex h-8 w-full items-center justify-center rounded-md hover:bg-accent", active && "bg-accent")}>
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
          <div onDoubleClick={(e) => (e.stopPropagation(), setEditing(true))} className={cn("truncate text-sm", !s.running && "text-muted-foreground")}>
            {displayName(s)}
          </div>
        )}
      </div>
      <button
        title="Kill session"
        onClick={(e) => (e.stopPropagation(), onKill())}
        className={cn(
          "absolute top-1/2 right-1.5 hidden size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-popover text-muted-foreground shadow-sm group-hover:flex hover:text-destructive",
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

type Props = {
  sessions: Session[];
  current: string | null;
  collapsed: boolean;
  graphing: boolean;
  onToggle: () => void;
  onGraph: () => void;
  onResume: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onKill: (id: string) => void;
  onRename: (id: string, name: string) => void;
};

export function Sidebar({ sessions, current, collapsed, graphing, onToggle, onGraph, onResume, onNew, onOpen, onKill, onRename }: Props) {
  const agents = sessions.filter((s) => !isSentry(s)), sentries = sessions.filter(isSentry);
  const rows = (list: Session[]) =>
    list.map((s) => <Row key={s.id} s={s} active={s.id === current} collapsed={collapsed} onOpen={() => onOpen(s.id)} onKill={() => onKill(s.id)} onRename={(n) => onRename(s.id, n)} />);

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
              <Tip label="Graph view" keys="⌘G">
                <Button variant="ghost" size="icon" className={cn("size-8 text-muted-foreground", graphing && "bg-accent text-primary")} onClick={onGraph}>
                  <Network />
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
      <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
        <div className="flex flex-col gap-0.5 p-1.5">{rows(agents)}</div>
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
