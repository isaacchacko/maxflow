import { AlarmClock, ArrowUpToLine, Check, MessageSquareReply, Pin, Quote, RotateCcw } from "lucide-react";
import type { Objective, Thread } from "@/mock";
import { cn, hasText } from "@/lib/utils";
import { HoverBar } from "@/threads/HoverBar";
import { MovedChip } from "@/threads/Moved";
import { goToMessage } from "@/threads/jump";
import { MessageRow } from "@/threads/MessageRow";
import { pausedLabel } from "@/threads/Pause";
import { openRaise } from "@/threads/Raise";
import { Replies } from "@/threads/Replies";
import { pinItem, RowMenu, type MenuItem } from "@/threads/RowMenu";
import { ShotScope, shotsOf } from "@/threads/Viewer";

export type Message = Thread["messages"][number];
export type RowActions = {
  open: (id: string) => void;
  reply: (id: string) => void;
  toggle: (t: Thread) => void;
  pause: (id: string) => void;
  quote: (id: string) => void;
  menu: (t: Thread) => (MenuItem | false | undefined)[];
};

const PREVIEW_BODY = "max-h-36 overflow-hidden [&_img]:max-h-28";

const isOnLinkOrChip = (e: React.MouseEvent) => e.target instanceof Element && e.target.closest("a, button") !== null;

function ResolvedPill({ t, onToggle }: { t: Thread; onToggle: (t: Thread) => void }) {
  return (
    <button data-agent={`inbox-reopen:${t.id}`} title="Reopen" onClick={() => onToggle(t)} className="mt-1 flex items-center gap-1 rounded-full border border-ok/40 bg-ok/10 px-2 py-0.5 text-xs font-medium text-ok hover:border-ok">
      <Check className="size-3" />
      Resolved
    </button>
  );
}

const resolveAction = (t: Thread, onToggle: (t: Thread) => void) => ({ label: t.resolved ? "Reopen" : "Resolve", icon: t.resolved ? RotateCcw : Check, run: () => onToggle(t), agent: `inbox-resolve:${t.id}` });

export function MovedRow({ t, to, first, onToggle }: { t: Thread; to: NonNullable<Thread["movedTo"]>; first: Message; onToggle: (t: Thread) => void }) {
  return (
    <div data-row={t.id} data-agent={`inbox-moved:${t.id}`} className="group/row group/bar relative mt-2.5">
      <div className="opacity-60">
        <MessageRow
          from={first.from}
          at={first.at}
          text={first.text}
          grouped={false}
          className="cursor-pointer"
          bodyClassName={PREVIEW_BODY}
          onClick={e => {
            if (!isOnLinkOrChip(e)) goToMessage(to.id, to.messageId);
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <MovedChip to={to} />
            {t.resolved && <ResolvedPill t={t} onToggle={onToggle} />}
          </div>
        </MessageRow>
      </div>
      <HoverBar agent={t.id} actions={[resolveAction(t, onToggle)]} menu={[]} />
    </div>
  );
}

function objectiveText(t: Thread, objectives: Objective[]) {
  if (hasText(t.objectiveId)) return objectives.find(o => o.id === t.objectiveId)?.title;
  return t.asks ? "" : "routing…";
}

function RowMeta({ t, objectives }: { t: Thread; objectives: Objective[] }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
      {t.pinned && <Pin aria-label="pinned" className="size-3 shrink-0 self-center text-muted-foreground" />}
      {t.asks && <span className="shrink-0 rounded-full bg-warn-soft px-2 font-medium text-warn">needs you</span>}
      <span className="truncate">{objectiveText(t, objectives)}</span>
      {t.paused && (
        <span data-agent={`inbox-paused:${t.id}`} title={pausedLabel(t.paused)} className="flex min-w-0 items-center gap-1 whitespace-nowrap">
          <AlarmClock className="size-3 shrink-0 self-center" />
          <span className="min-w-0 truncate">{pausedLabel(t.paused)}</span>
        </span>
      )}
    </span>
  );
}

function openerActions(t: Thread, quote: (id: string) => void) {
  const opener = t.messages[0];
  const id = opener?.id;
  if (!opener || !hasText(id)) return [];
  return [
    { label: "Quote", icon: Quote, run: () => quote(t.id), agent: `inbox-quote:${t.id}` },
    { label: "Raise to Threads", icon: ArrowUpToLine, run: () => openRaise(t.id, id, opener.text), agent: `inbox-raise:${t.id}` },
  ];
}

type ThreadRowProps = { t: Thread; first: Message; isGrouped: boolean; objectives: Objective[]; actions: RowActions };

export function ThreadRow({ t, first, isGrouped, objectives, actions }: ThreadRowProps) {
  const hasReplies = t.messages.length > 1 || t.pending !== undefined || isGrouped;
  return (
    <RowMenu agent={t.id} items={actions.menu(t)}>
      <div data-row={t.id} data-agent={`inbox-row:${t.id}`} className={cn("group/row group/bar relative", !isGrouped && "mt-2.5")}>
        <div className={cn((t.resolved !== undefined || t.paused !== undefined) && "opacity-50")}>
          <ShotScope.Provider value={shotsOf(t.messages)}>
            <MessageRow
              from={first.from}
              at={first.at}
              text={first.text}
              ext={first.ext}
              grouped={isGrouped}
              className="cursor-pointer"
              bodyClassName={PREVIEW_BODY}
              onClick={e => {
                if (!isOnLinkOrChip(e)) actions.open(t.id);
              }}
              meta={<RowMeta t={t} objectives={objectives} />}
            >
              {(hasReplies || t.resolved) && (
                <div className="flex flex-wrap items-center gap-2">
                  {hasReplies && <Replies t={t} />}
                  {t.resolved && <ResolvedPill t={t} onToggle={actions.toggle} />}
                </div>
              )}
            </MessageRow>
          </ShotScope.Provider>
        </div>
        <HoverBar
          agent={t.id}
          actions={[
            resolveAction(t, actions.toggle),
            { label: t.paused ? "Pause again…" : "Pause…", icon: AlarmClock, run: () => actions.pause(t.id), agent: `inbox-pause:${t.id}` },
            { label: "Reply in thread", icon: MessageSquareReply, run: () => actions.reply(t.id), agent: `inbox-reply:${t.id}` },
            ...openerActions(t, actions.quote),
            pinItem(t),
          ]}
          menu={actions.menu(t)}
        />
      </div>
    </RowMenu>
  );
}
