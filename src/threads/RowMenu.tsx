import { AlarmClock, ArrowUpToLine, Check, Copy, ExternalLink, Link, Mail, MailOpen, MessageSquareReply, Pin, PinOff, Play, Quote, RotateCcw, type LucideIcon } from "lucide-react";
import { ContextMenu, DropdownMenu } from "radix-ui";
import { hasText } from "@/lib/utils";
import type { Thread } from "@/mock";
import { setPaused, setPinned } from "@/store";
import { openPause } from "./Pause";
import { repliesOf } from "./Replies";
import { markRead, markUnread, unseenDeep } from "./seen";

export type MenuItem = "-" | { label: string; icon: LucideIcon; run: () => void; agent?: string; pressed?: boolean };

export const copy = (text: string) => {
  void navigator.clipboard.writeText(text);
};
export const threadLink = (id: string) => `${location.origin}${location.pathname}#thread/${id}`;

export const applying = (items: (MenuItem | false | undefined)[] | undefined) => (items ?? []).filter(x => x !== false && x !== undefined).filter((x, i, all) => x !== "-" || (i > 0 && i < all.length - 1 && all[i - 1] !== "-"));

export function RowMenu({ items, agent, children }: { items: (MenuItem | false | undefined)[]; agent: string; children: React.ReactElement }) {
  const shown = applying(items);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild className="data-[state=open]:bg-muted/40">
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content data-agent={`menu:${agent}`} onEscapeKeyDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onCloseAutoFocus={e => e.preventDefault()} className="z-50 min-w-48 border bg-background p-1 text-sm shadow-lg">
          {shown.map((x, i) =>
            x === "-" ? (
              <ContextMenu.Separator key={i} className="my-1 h-px bg-border" />
            ) : (
              <ContextMenu.Item
                key={x.label}
                data-agent={x.agent}
                onSelect={x.run}
                className="flex cursor-pointer items-center gap-2 px-2 py-1 outline-none select-none data-highlighted:bg-muted"
              >
                <x.icon className="size-3.5 text-muted-foreground" />
                <span className="flex-1">{x.label}</span>
              </ContextMenu.Item>
            ),
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function DropMenu({ items, agent, children }: { items: (MenuItem | false | undefined)[]; agent: string; children: React.ReactElement }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content data-agent={`menu:${agent}`} align="end" sideOffset={4} onEscapeKeyDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onCloseAutoFocus={e => e.preventDefault()} className="z-50 min-w-48 border bg-background p-1 text-sm shadow-lg">
          {applying(items).map((x, i) =>
            x === "-" ? (
              <DropdownMenu.Separator key={i} className="my-1 h-px bg-border" />
            ) : (
              <DropdownMenu.Item key={x.label} data-agent={x.agent} onSelect={x.run} className="flex cursor-pointer items-center gap-2 px-2 py-1 outline-none select-none data-highlighted:bg-muted">
                <x.icon className="size-3.5 text-muted-foreground" />
                <span className="flex-1">{x.label}</span>
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function threadItems(t: Thread, all: Thread[], on: { open?: () => void; reply?: () => void; resolve: () => void; pause?: () => void }): (MenuItem | false | undefined)[] {
  return [
    on.open && { label: "Open", icon: ExternalLink, run: on.open },
    on.reply && { label: "Reply", icon: MessageSquareReply, run: on.reply },
    "-",
    unseenDeep(t, all) > 0 && { label: "Mark read", icon: MailOpen, run: () => markRead(t, all), agent: `mark-read:${t.id}` },
    unseenDeep(t, all) === 0 && repliesOf(t).length > 0 && { label: "Mark unread", icon: Mail, run: () => markUnread(t), agent: `mark-unread:${t.id}` },
    { label: t.resolved ? "Reopen" : "Resolve", icon: t.resolved ? RotateCcw : Check, run: on.resolve, agent: `menu-resolve:${t.id}` },
    !hasText(t.parentId) && { label: t.paused ? "Pause again…" : "Pause…", icon: AlarmClock, run: on.pause ?? (() => openPause(t.id)), agent: `menu-pause:${t.id}` },
    t.paused && { label: "Unpause", icon: Play, run: () => {
        void setPaused(t.id, null);
      }, agent: `menu-unpause:${t.id}` },
    pinItem(t),
    "-",
    { label: "Copy link", icon: Link, run: () => copy(threadLink(t.id)) },
    { label: "Copy text", icon: Copy, run: () => copy(t.messages[0]?.text ?? t.title) },
  ];
}

export const pinItem = (t: Thread): Exclude<MenuItem, "-"> => ({
  label: t.pinned ? "Unpin" : "Pin",
  icon: t.pinned ? PinOff : Pin,
  run: () => {
    void setPinned(t.id, !t.pinned);
  },
  agent: `pin:${t.id}`,
  pressed: Boolean(t.pinned),
});

export function messageItems(text: string, on: { open?: () => void; reply?: () => void; quote?: () => void; raise?: () => void; unread?: () => void; link?: string }): (MenuItem | false | undefined)[] {
  const link = on.link;
  return [
    on.open ? { label: "Open subthread", icon: MessageSquareReply, run: on.open } : on.reply && { label: "Reply in thread", icon: MessageSquareReply, run: on.reply },
    on.quote && { label: "Quote", icon: Quote, run: on.quote },
    on.raise && { label: "Raise to Threads", icon: ArrowUpToLine, run: on.raise, agent: "raise" },
    "-",
    on.unread && { label: "Mark unread from here", icon: Mail, run: on.unread },
    "-",
    hasText(link) && { label: "Copy link", icon: Link, run: () => copy(link) },
    { label: "Copy text", icon: Copy, run: () => copy(text) },
  ];
}
