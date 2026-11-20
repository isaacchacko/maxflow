import { AlarmClock, ArrowLeft, Check, ChevronRight, MessagesSquare, PanelRight, RotateCcw } from "lucide-react";
import { Fragment } from "react";
import { FitLabel, FitRow } from "@/components/Fit";
import { Button } from "@/components/ui/button";
import { cn, hasText } from "@/lib/utils";
import type { Thread } from "@/mock";
import { when } from "../MessageRow";
import { pausedLabel } from "../Pause";
import { PinToggle } from "../PinToggle";
import { RowMenu, threadItems } from "../RowMenu";
import { AgentStack } from "../ThreadPanel";

function ancestorsOf(thread: Thread, all: Thread[]) {
  const ancestors: Thread[] = [];
  const parentOf = (t: Thread) => all.find(x => x.id === t.parentId);
  for (let up = parentOf(thread); up; up = parentOf(up)) ancestors.unshift(up);
  return ancestors;
}

function Breadcrumbs({ ancestors }: { ancestors: Thread[] }) {
  return ancestors.map(a => (
    <Fragment key={a.id}>
      <a href={`#thread/${a.id}`} data-agent={`thread-up:${a.id}`} title={a.title} className="hidden max-w-56 min-w-0 shrink-[2] truncate text-sm whitespace-nowrap text-muted-foreground hover:text-foreground md:block">
        {a.title}
      </a>
      <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground md:block" />
    </Fragment>
  ));
}

function TitleAndState({ thread }: { thread: Thread }) {
  return (
    <>
      <h1 title={thread.title} data-agent={`thread-title:${thread.id}`} className={cn("min-w-24 truncate group-data-[fit=glyph]/fit:min-w-12 text-xl font-semibold tracking-tight", thread.resolved && "text-muted-foreground")}>
        {thread.title}
      </h1>
      {thread.resolved && <span className="hidden shrink-0 text-xs whitespace-nowrap text-muted-foreground md:inline">resolved {when(thread.resolved.at)}</span>}
      {thread.paused && (
        <span data-agent="thread-paused" title={`paused ${pausedLabel(thread.paused)}`} className="hidden min-w-0 shrink-[2] truncate text-xs whitespace-nowrap text-muted-foreground md:block">
          paused {pausedLabel(thread.paused)}
        </span>
      )}
    </>
  );
}

function DetailToggle({ isShown, onToggle }: { isShown: boolean; onToggle: () => void }) {
  return (
    <button
      data-agent="thread-detail-toggle"
      aria-pressed={isShown}
      title={isShown ? "Hide details" : "Show details"}
      onClick={onToggle}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors", isShown ? "border-link/30 bg-link/10 text-link" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground")}
    >
      <PanelRight className="size-4" />
    </button>
  );
}

function PauseAndResolve({ thread, onResolve, onPause }: { thread: Thread; onResolve: () => void; onPause: () => void }) {
  return (
    <>
      {!hasText(thread.parentId) && (
        <Button variant="outline" size="sm" data-agent="thread-pause" title="Pause until a time" onClick={onPause} className="shrink-0">
          <AlarmClock />
          <FitLabel full={thread.paused ? "Paused" : "Pause"} glyph={false} />
        </Button>
      )}
      <Button variant="outline" size="sm" data-agent="thread-resolve" title={thread.resolved ? "Reopen" : "Resolve"} onClick={onResolve} className="shrink-0">
        {thread.resolved ? <RotateCcw /> : <Check />}
        <FitLabel full={thread.resolved ? "Reopen" : "Resolve"} glyph={false} />
      </Button>
    </>
  );
}

const scrollToAgents = (threadId: string) => document.querySelector(`#${CSS.escape(`agents-${threadId}`)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

type HeaderProps = {
  thread: Thread;
  all: Thread[];
  back: string;
  isPaneOpen: boolean;
  isDetailShown: boolean;
  onDetailShown: (isShown: boolean) => void;
  onResolve: () => void;
  onPause: () => void;
};

export function ThreadHeader({ thread, all, back, isPaneOpen, isDetailShown, onDetailShown, onResolve, onPause }: HeaderProps) {
  const openAgents = () => {
    onDetailShown(true);
    requestAnimationFrame(() => scrollToAgents(thread.id));
  };
  return (
    <RowMenu agent="thread-header" items={threadItems(thread, all, { resolve: onResolve, pause: onPause })}>
      <div className="shrink-0">
        <FitRow className="h-12 items-center gap-3 border-b px-3 data-[fit=glyph]:gap-1.5">
          <Button variant="ghost" size="icon" asChild data-agent="back" className="shrink-0">
            <a href={hasText(thread.parentId) ? `#thread/${thread.parentId}` : `#${back}`}>
              <ArrowLeft />
            </a>
          </Button>
          <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
          <Breadcrumbs ancestors={ancestorsOf(thread, all)} />
          <TitleAndState thread={thread} />
          <span className="ml-auto" />
          <AgentStack thread={thread} onOpen={openAgents} />
          {isPaneOpen && <DetailToggle isShown={isDetailShown} onToggle={() => onDetailShown(!isDetailShown)} />}
          <PinToggle thread={thread} />
          <PauseAndResolve thread={thread} onResolve={onResolve} onPause={onPause} />
        </FitRow>
      </div>
    </RowMenu>
  );
}
