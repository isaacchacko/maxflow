import { Fragment } from "react";
import { cn, hasText } from "@/lib/utils";
import type { Thread } from "@/mock";
import { HoverBar } from "../HoverBar";
import { MessageRow } from "../MessageRow";
import { Replies } from "../Replies";
import { RowMenu, type MenuItem } from "../RowMenu";
import { hasReplies, keyOf, replyBarActions, rootBarActions, ROOT_INDEX, type Message, type MessageActions } from "./actions";
import { conversationOf, EarlierInTheConversationLine, MessageMarks } from "./marks";
import type { ThreadNav } from "./nav";

const SAME_SENDER_GROUP_MS = 5 * 60_000;

type Menu = (m: Message, k: string) => (MenuItem | false | undefined)[];

type RootProps = { thread: Thread; all: Thread[]; root: Message; actions: MessageActions; messageMenu: Menu; onResolve: () => void; onPause: () => void };

export function RootMessage({ thread, all, root, actions, messageMenu, onResolve, onPause }: RootProps) {
  const k = keyOf(root, ROOT_INDEX);
  const home = thread.parentId ?? thread.id;
  return (
    <RowMenu agent={`msg:${k}`} items={messageMenu(root, k)}>
      <div data-msg={root.id} data-agent={`message:${root.id}`} data-thread={home} data-row={k} className="group/bar relative">
        <MessageRow from={root.from} at={root.at} text={root.text} ext={root.ext}>
          <MessageMarks message={root} threads={all} thread={home} />
        </MessageRow>
        <HoverBar agent={`msg:${k}`} actions={rootBarActions(thread, root, actions, { onResolve, onPause })} menu={messageMenu(root, k)} />
      </div>
    </RowMenu>
  );
}

const isContextShownBefore = (thread: Thread, m: Message) =>
  m.ext?.context === true && thread.messages.slice(0, thread.messages.indexOf(m)).some(x => x.ext?.link === m.ext?.link && x.text === m.text);

const isFirstSinceResolved = (thread: Thread, m: Message, prev: Message | undefined) => thread.resolved !== undefined && m.at > thread.resolved.at && !(prev && prev.at > thread.resolved.at);

function isGroupedWithPrevious(m: Message, prev: Message | undefined) {
  if (m.wake === true || prev?.from !== m.from) return false;
  return prev.ext?.name === m.ext?.name && (prev.ext?.context === true) === (m.ext?.context === true) && Date.parse(m.at) - Date.parse(prev.at) <= SAME_SENDER_GROUP_MS;
}

const isFirstOfEarlierContext = (m: Message, before: Message | undefined) => m.ext?.context === true && before?.ext?.context !== true;

function NewLine({ lineRef, isSinceResolved }: { lineRef: React.RefObject<HTMLDivElement | null>; isSinceResolved: boolean }) {
  return (
    <div ref={lineRef} data-agent="unread-line" className="my-2 flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
      <span className="h-px flex-1 bg-destructive" />
      {isSinceResolved ? "New since resolved" : "New"}
    </div>
  );
}

type ReplyProps = {
  thread: Thread;
  all: Thread[];
  root: Message | undefined;
  replies: Message[];
  i: number;
  isNew: boolean;
  lineRef: React.RefObject<HTMLDivElement | null>;
  actions: MessageActions;
  messageMenu: Menu;
  nav: ThreadNav;
};

const STREAMS_IN_WHEN_UNDER_MS = 6000;

const isStreamingIn = (m: Message) => m.from !== "isaac" && Date.now() - Date.parse(m.at) < STREAMS_IN_WHEN_UNDER_MS;

function ReplyBody({ thread, all, root, replies, i, actions, messageMenu, nav, isGrouped }: Omit<ReplyProps, "isNew" | "lineRef"> & { isGrouped: boolean }) {
  const m = replies[i];
  if (!m) return null;
  const k = keyOf(m, i);
  const sub = actions.subOf(m.id);
  const lastSaidWhere = (replies.slice(0, i).findLast(x => x.ext !== undefined) ?? root)?.ext?.link;
  return (
    <RowMenu agent={`msg:${k}`} items={messageMenu(m, k)}>
      <div data-msg={m.id} data-agent={`message:${m.id}`} data-thread={thread.id} data-row={k} className="group/bar relative">
        <MessageRow from={m.from} at={m.at} text={m.text} ext={m.ext} where={m.ext !== undefined && conversationOf(m.ext.link) !== conversationOf(lastSaidWhere)} grouped={isGrouped} className={cn(!isGrouped && i > 0 && "mt-2.5")} bodyClassName={isStreamingIn(m) ? "streams-in" : undefined}>
          <MessageMarks message={m} threads={all} thread={thread.id} />
          {hasReplies(sub) && <Replies t={sub} />}
        </MessageRow>
        <HoverBar agent={`msg:${k}`} actions={hasText(m.id) ? replyBarActions({ thread, messageId: m.id, text: m.text, raiseIt: () => actions.raise(k), nav }) : []} menu={messageMenu(m, k)} />
      </div>
    </RowMenu>
  );
}

export function ReplyRow(props: ReplyProps) {
  const { thread, root, replies, i, isNew, lineRef } = props;
  const m = replies[i];
  if (!m || isContextShownBefore(thread, m)) return null;
  const prev = replies[i - 1];
  const isSinceResolved = isFirstSinceResolved(thread, m, prev);
  const isGrouped = !isNew && isGroupedWithPrevious(m, prev);
  const isStartOfEarlierContext = isFirstOfEarlierContext(m, prev ?? root);
  return (
    <Fragment>
      {isSinceResolved && !isNew && <p className="my-2 border-t pt-1 text-center text-xs text-muted-foreground">new since resolved</p>}
      {isStartOfEarlierContext && <EarlierInTheConversationLine />}
      {isNew && <NewLine lineRef={lineRef} isSinceResolved={isSinceResolved} />}
      <ReplyBody {...props} isGrouped={isGrouped} />
    </Fragment>
  );
}
