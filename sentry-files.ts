import { watchedStateFile } from "./state";
import { publish } from "./bus";
import { type Session, sessions } from "./sessions";

// Lets the graph show one session reading or writing another; held is true while a wait is still watching.
export function touchFrom(req: Request, s: Session, kind: "read" | "write", held = false) {
  const from = sessions.get(req.headers.get("x-maxflow-from") ?? "");
  if (from && from !== s) publish(`touch/${from.id}/${s.id}`, { from: from.id, to: s.id, kind, held });
}
// Its board of the PRs that need the user, { updated, next, sections: [{ title, items: [{ pr, url, note }] }] }, and the queue of every open PR it reads.
export const reviewBoard = watchedStateFile<unknown>("review-board.json", null);
export const reviewQueue = watchedStateFile<unknown[]>("review-queue.json", []);
