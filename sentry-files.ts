import { callerOf } from "./shared/legacy-maxflow";
import { watchedStateFile } from "./state";
import { publish } from "./bus";
import { type Session, sessions } from "./sessions";

export function touchFrom(req: Request, s: Session, kind: "read" | "write", isHeldByAWaitStillWatching = false) {
  const from = sessions.get(callerOf(req));
  if (from && from !== s) publish(`touch/${from.id}/${s.id}`, { from: from.id, to: s.id, kind, held: isHeldByAWaitStillWatching });
}

type PrsThatNeedTheUser = { updated: unknown; next: unknown; sections: { title: string; items: { pr: unknown; url: string; note: string }[] }[] };
export const reviewBoard = watchedStateFile<PrsThatNeedTheUser | null>("review-board.json", null);
export const reviewQueueOfEveryOpenPr = watchedStateFile<unknown[]>("review-queue.json", []);
