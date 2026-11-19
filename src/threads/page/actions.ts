import { AlarmClock, ArrowUpToLine, Check, MessageSquareReply, Quote, RotateCcw } from "lucide-react";
import { hasText } from "@/lib/utils";
import type { Thread } from "@/mock";
import { openSubthread } from "@/store";
import { quoteInto, quoted } from "../Composer";
import { composeOnArrival } from "../jump";
import { openRaise } from "../Raise";
import { messageItems, pinItem, type MenuItem } from "../RowMenu";
import type { ThreadNav } from "./nav";

export type Message = Thread["messages"][number];

export const ROOT_INDEX = -1;
export const keyOf = (m: { id?: string | undefined }, i: number) => m.id ?? `#${i}`;

export const hasReplies = (sub: Thread | undefined): sub is Thread => sub !== undefined && (sub.messages.length > 0 || sub.pending !== undefined);

export function rootOf(thread: Thread, all: Thread[]) {
  if (!hasText(thread.parentId)) return thread.messages[0];
  return all.find(t => t.id === thread.parentId)?.messages.find(m => m.id === thread.parentMessageId);
}

type Page = { thread: Thread; all: Thread[]; root: Message | undefined; replies: Message[]; nav: ThreadNav; focusComposer: () => void };

export function messageActions({ thread, all, root, replies, nav, focusComposer }: Page) {
  const id = thread.id;
  const byKey = (k: string) => (root && k === keyOf(root, ROOT_INDEX) ? root : replies.find((m, i) => keyOf(m, i) === k));
  const homeOf = (m: Message) => (m === root ? (thread.parentId ?? id) : id);
  return {
    homeOf,
    subOf: (messageId: string | undefined) => all.find(t => t.parentId === id && t.parentMessageId === messageId),
    open: (k: string) => {
      const sub = all.find(t => t.parentId === id && t.parentMessageId === k);
      if (hasReplies(sub)) nav.open(sub.id);
    },
    reply: (k: string) => {
      if (k === root?.id || !hasText(byKey(k)?.id)) {
        focusComposer();
        return;
      }
      composeOnArrival();
      void openSubthread(id, k, nav.open);
    },
    raise: (k: string) => {
      const m = byKey(k);
      if (m !== undefined && hasText(m.id)) openRaise(homeOf(m), m.id, m.text);
    },
    quote: (k: string) => {
      const m = byKey(k);
      if (m !== undefined && hasText(m.id)) quoteInto(`thread:${id}`, quoted(m.text, homeOf(m), m.id));
    },
  };
}

export type MessageActions = ReturnType<typeof messageActions>;

const withId = (m: Message, k: string, actions: MessageActions) =>
  hasText(m.id) ? { reply: () => actions.reply(k), quote: () => actions.quote(k), raise: () => actions.raise(k), link: `[[msg:${actions.homeOf(m)}/${m.id}]]` } : {};

export function messageMenuFor(thread: Thread, actions: MessageActions, markUnreadFrom: (at: number) => void) {
  const firstMarkable = hasText(thread.parentId) ? 0 : 1;
  return (m: Message, k: string) => {
    const at = thread.messages.indexOf(m);
    return messageItems(m.text, {
      ...(hasReplies(actions.subOf(m.id)) && { open: () => actions.open(k) }),
      ...withId(m, k, actions),
      ...(at >= firstMarkable && { unread: () => markUnreadFrom(at) }),
    });
  };
}

type Action = Exclude<MenuItem, "-">;
type ThreadRun = { onResolve: () => void; onPause: () => void };

export function rootBarActions(thread: Thread, root: Message, actions: MessageActions, { onResolve, onPause }: ThreadRun): (Action | false)[] {
  const k = keyOf(root, ROOT_INDEX);
  const hasId = hasText(root.id);
  return [
    { label: thread.resolved ? "Reopen" : "Resolve", icon: thread.resolved ? RotateCcw : Check, run: onResolve, agent: `msg-resolve:${thread.id}` },
    !hasText(thread.parentId) && { label: thread.paused ? "Pause again…" : "Pause…", icon: AlarmClock, run: onPause, agent: `msg-pause:${thread.id}` },
    { label: "Reply", icon: MessageSquareReply, run: () => actions.reply(k) },
    hasId && { label: "Quote", icon: Quote, run: () => actions.quote(k), agent: `quote:${root.id}` },
    hasId && { label: "Raise to Threads", icon: ArrowUpToLine, run: () => actions.raise(k), agent: `raise:${root.id}` },
    pinItem(thread),
  ];
}

type ReplyBar = { thread: Thread; messageId: string; text: string; raiseIt: () => void; nav: ThreadNav };

export function replyBarActions({ thread, messageId, text, raiseIt, nav }: ReplyBar): Action[] {
  return [
    {
      label: "Reply in thread",
      icon: MessageSquareReply,
      run: () => {
        void openSubthread(thread.id, messageId, nav.open);
      },
      agent: `reply-in-thread:${messageId}`,
    },
    { label: "Quote", icon: Quote, run: () => quoteInto(`thread:${thread.id}`, quoted(text, thread.id, messageId)), agent: `quote:${messageId}` },
    { label: "Raise to Threads", icon: ArrowUpToLine, run: raiseIt, agent: `raise:${messageId}` },
  ];
}
