import type { Block } from "./model";
import { objectives, saveObjectives, saveTasks, tasks } from "./stores";

// A page (an objective's or a task's) is a grid of cards its agents keep current.
export function pageOf(ref: string): { page: Block[]; save: () => void } | null {
  const [type, id] = ref.split("/");
  if (type === "objective") {
    const o = objectives.find((x) => x.id === id);
    return o ? { page: o.page, save: saveObjectives } : null;
  }
  const t = type === "task" ? tasks.find((x) => x.id === Number(id.replace(/^t/, ""))) : undefined;
  return t ? { page: (t.page ??= []), save: saveTasks } : null;
}
