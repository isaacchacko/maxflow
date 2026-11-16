import { Check, Copy, ExternalLink, Link, Mail, MailOpen, MessageSquareReply, MessagesSquare, Quote, RotateCcw, Zap, type LucideIcon } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { Kbd } from "@/components/ui/kbd";
import type { Thread } from "@/mock";
import { setKind } from "@/store";
import { repliesOf } from "./Replies";
import { markRead, markUnread, unseenDeep } from "./seen";

/** One line of a right-click menu, with the vim key that does the same where there is one; "-" draws a rule. */
export type MenuItem = { label: string; icon: LucideIcon; keys?: string; run(): void; agent?: string } | "-";

export const copy = (text: string) => void navigator.clipboard.writeText(text);
export const threadLink = (id: string) => `${location.origin}${location.pathname}#thread/${id}`;

/** A right-click menu on its one child (a row, a message, a header), which draws as hovered while the menu is open. */
export function RowMenu({ items, agent, children }: { items: (MenuItem | false | undefined)[]; agent: string; children: React.ReactElement }) {
  // Only the items that apply; a rule never leads, trails or doubles up once the others are left out.
  const shown = (items ?? []).filter(x => !!x).filter((x, i, all) => x !== "-" || (i > 0 && i < all.length - 1 && all[i - 1] !== "-"));
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild className="data-[state=open]:bg-muted/40">
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        {/* Its keys are its own: Escape closes the menu without also climbing a level, and the view keys don't switch views.
            Closing leaves focus where the chosen item put it (the box, for Quote), not back on the row. */}
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
                {x.keys && <Kbd>{x.keys}</Kbd>}
              </ContextMenu.Item>
            ),
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * What a thread offers wherever it is drawn (an inbox row, its own header): `open` and `reply` where it isn't already open, and
 * `resolve` as the page resolves it, so the inbox keeps the row in place and the header climbs a level.
 */
export function threadItems(t: Thread, all: Thread[], on: { open?(): void; reply?(): void; resolve(): void }): (MenuItem | false | undefined)[] {
  // A command has no new-replies count anywhere, so read and unread are only a conversation's.
  const talk = t.kind !== "command";
  return [
    on.open && { label: "Open", icon: ExternalLink, keys: "Enter", run: on.open },
    on.reply && { label: "Reply", icon: MessageSquareReply, keys: "r", run: on.reply },
    "-",
    talk && unseenDeep(t, all) > 0 && { label: "Mark read", icon: MailOpen, run: () => markRead(t, all), agent: `mark-read:${t.id}` },
    talk && unseenDeep(t, all) === 0 && repliesOf(t).length > 0 && { label: "Mark unread", icon: Mail, run: () => markUnread(t), agent: `mark-unread:${t.id}` },
    !t.parentId && (talk ? { label: "Convert to command", icon: Zap, run: () => setKind(t.id, "command") } : { label: "Convert to conversation", icon: MessagesSquare, run: () => setKind(t.id, "conversation") }),
    { label: t.resolved ? "Reopen" : "Resolve", icon: t.resolved ? RotateCcw : Check, keys: "x", run: on.resolve, agent: `menu-resolve:${t.id}` },
    "-",
    { label: "Copy link", icon: Link, run: () => copy(threadLink(t.id)) },
    { label: "Copy text", icon: Copy, run: () => copy(t.messages[0]?.text ?? t.title) },
  ];
}

/** What a message offers: its subthread if it has one, else a reply in thread; a quote; unread from it on; its link and text. */
export function messageItems(text: string, on: { open?(): void; reply?(): void; quote?(): void; unread?(): void; link?: string }): (MenuItem | false | undefined)[] {
  return [
    on.open ? { label: "Open subthread", icon: MessageSquareReply, keys: "Enter", run: on.open } : on.reply && { label: "Reply in thread", icon: MessageSquareReply, keys: "r", run: on.reply },
    on.quote && { label: "Quote", icon: Quote, keys: "y", run: on.quote },
    "-",
    on.unread && { label: "Mark unread from here", icon: Mail, run: on.unread },
    "-",
    !!on.link && { label: "Copy link", icon: Link, run: () => copy(on.link!) },
    { label: "Copy text", icon: Copy, run: () => copy(text) },
  ];
}
