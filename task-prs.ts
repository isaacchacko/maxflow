import type { Task } from "./model";
import { taskPrs } from "./lifecycle";

// How far a task's PRs got, counting only those whose state is known.
export function prProgress(t: Task) {
  const states = t.links.flatMap((url) => taskPrs()[url] ?? []);
  return { merged: states.filter((s) => s === "MERGED").length, closed: states.filter((s) => s === "CLOSED").length, total: states.length };
}
