import { CornerDownRight } from "lucide-react";
import type { Thread } from "@/mock";
import { objectiveStore } from "@/store";
import { goToMessage } from "./jump";

export function MovedChip({ to }: { to: NonNullable<Thread["movedTo"]> }) {
  const objective = objectiveStore.use().find(o => o.id === to.objectiveId)?.title;
  return (
    <button data-agent={`moved-to:${to.id}`} onClick={() => goToMessage(to.id, to.messageId)} className="mt-1 -ml-1 flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-full border bg-card py-0.5 pr-2.5 pl-2 text-xs hover:border-ring">
      <CornerDownRight className="size-3 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">Moved to</span>
      <span className="min-w-0 truncate font-semibold text-link">{to.title}</span>
      {objective !== undefined && <span className="min-w-0 shrink truncate text-muted-foreground">on {objective}</span>}
    </button>
  );
}
