import { createContext } from "react";
import { hasText } from "@/lib/utils";
import type { Thread } from "@/mock";
import { setResolved, threadStore } from "@/store";
import { goToMessage } from "../jump";

export function threadUp(id: string, view: string) {
  const t = threadStore.get().find(x => x.id === id);
  if (t === undefined || !hasText(t.parentId)) {
    location.hash = view;
    return;
  }
  goToMessage(t.parentId, t.parentMessageId);
}

export type ThreadNav = { open: (threadId: string) => void; up: (threadId: string, view: string) => void };

const openThreadPage = (id: string) => {
  location.hash = `thread/${id}`;
};

export const ThreadNavContext = createContext<ThreadNav>({ open: openThreadPage, up: threadUp });

export async function resolveOrReopen(thread: Thread, climbOnceResolved: () => void) {
  const isResolving = !thread.resolved;
  await setResolved(thread.id, isResolving);
  if (isResolving) climbOnceResolved();
}
